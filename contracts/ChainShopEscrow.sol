// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title ChainShopEscrow
/// @notice Escrow B2B ChainShop di Sepolia memakai Mock USDT (tanpa nilai uang asli).
///         - 1 order = 1 buyer + 1 seller, dicatat per `orderId` (bytes32 dari ID order di DB).
///         - Buyer deposit: harga barang + ongkir + estimasi gas (±) untuk 2 transaksi seller
///           (markShipped & markDelivered). Seluruh estimasi gas diberikan ke seller.
///         - Invoice dicatat sebagai event `InvoiceRecorded` saat seller kirim barang.
///         - Admin (= arbiter) memutuskan refund. Semua batas waktu ditegakkan di contract,
///           sehingga fungsi auto* boleh dipanggil siapa saja (cron backend, buyer, seller).
contract ChainShopEscrow is AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    uint8 public constant MAX_REFUND_REQUESTS = 3;
    uint32 public constant MAX_ITEMS = 50;
    uint64 public constant MAX_WINDOW = 30 days;

    enum Status {
        None, //            0 belum ada
        Funded, //          1 buyer sudah deposit, menunggu seller kirim
        Shipped, //         2 seller kirim + invoice tercatat
        Delivered, //       3 seller tandai sampai, timer buyer berjalan
        RefundRequested, // 4 buyer ajukan refund, menunggu admin
        ReturnPending, //   5 refund disetujui, buyer wajib kirim retur
        ReturnShipped, //   6 buyer sudah kirim retur
        ReturnDelivered, // 7 retur sampai di seller, timer seller berjalan
        Completed, //       8 dana ke seller
        Refunded, //        9 harga barang + ongkir ke buyer, estimasi gas ke seller
        Cancelled //       10 seller tolak / lewat batas kirim, semua dana ke buyer
    }

    enum CancelReason {
        SellerRejected,
        ShipDeadlinePassed
    }

    struct Order {
        address buyer;
        address seller;
        uint256 itemsTotal; // total harga barang (6 desimal)
        uint256 shippingFee; // ongkir (6 desimal)
        uint256 gasFee; // estimasi gas untuk transaksi seller (6 desimal)
        uint32 itemCount; // jumlah baris barang di invoice
        uint64 fundedAt;
        uint64 shippedAt;
        uint64 deliveredAt;
        uint64 deadline; // batas waktu tahap aktif (0 = tidak ada)
        uint64 pausedRemaining; // sisa waktu buyer saat refund diajukan
        uint8 refundCount;
        bool refundFromShipped; // refund karena barang tak kunjung sampai
        Status status;
    }

    struct InvoiceItem {
        string name;
        uint256 qty;
        uint256 unitPrice; // 6 desimal
    }

    IERC20 public immutable token;
    mapping(bytes32 => Order) public orders;

    // ===== batas waktu (bisa diatur admin, mis. dipersingkat untuk demo) =====
    uint64 public sellerShipWindow = 3 days; //    deposit -> seller wajib ship
    uint64 public buyerConfirmWindow = 3 days; //  delivered -> buyer terima / refund
    uint64 public returnShipWindow = 3 days; //    refund disetujui -> buyer kirim retur
    uint64 public returnConfirmWindow = 3 days; // retur sampai -> seller konfirmasi
    uint64 public notDeliveredWindow = 7 days; //  shipped -> boleh refund jika belum sampai

    // ===== parameter estimasi gas =====
    // gasFee (mUSDT, 6 desimal) = (baseGasUnits + perItemGasUnits * itemCount) * gasPriceRefWei * musdtPerEth / 1e18
    uint256 public baseGasUnits;
    uint256 public perItemGasUnits;
    uint256 public gasPriceRefWei;
    uint256 public musdtPerEth; // jumlah unit mUSDT (6 desimal) per 1 ETH, kurs fixed

    // ===== events =====
    event Deposited(
        bytes32 indexed orderId,
        address indexed buyer,
        address indexed seller,
        uint256 itemsTotal,
        uint256 shippingFee,
        uint256 gasFee,
        uint256 shipDeadline
    );
    event OrderCancelled(bytes32 indexed orderId, CancelReason reason, uint256 refundedToBuyer);
    event Shipped(bytes32 indexed orderId, uint256 shippedAt);
    event InvoiceRecorded(
        bytes32 indexed orderId,
        string invoiceId,
        address indexed seller,
        address indexed buyer,
        InvoiceItem[] items,
        uint256 itemsTotal,
        uint256 shippingFee,
        uint256 gasFeeEstimate,
        uint256 totalPaid,
        string courier,
        string trackingNumber,
        uint64 purchasedAt,
        uint64 shippedAt
    );
    event Delivered(bytes32 indexed orderId, uint256 buyerDeadline);
    event Completed(bytes32 indexed orderId, uint256 paidToSeller, bool automatic);
    event RefundRequested(bytes32 indexed orderId, uint8 attempt, bool notDelivered);
    event RefundRejected(bytes32 indexed orderId, uint256 resumedDeadline);
    event RefundApproved(bytes32 indexed orderId, bool returnRequired, uint256 returnDeadline);
    event ReturnShipped(bytes32 indexed orderId);
    event ReturnDelivered(bytes32 indexed orderId, uint256 sellerDeadline);
    event ReturnExpired(bytes32 indexed orderId);
    event Refunded(bytes32 indexed orderId, uint256 toBuyer, uint256 toSeller, bool automatic);
    event GasParamsUpdated(uint256 baseGasUnits, uint256 perItemGasUnits, uint256 gasPriceRefWei, uint256 musdtPerEth);
    event WindowsUpdated(uint64 sellerShip, uint64 buyerConfirm, uint64 returnShip, uint64 returnConfirm, uint64 notDelivered);

    // ===== errors =====
    error InvalidStatus(Status current);
    error NotBuyer();
    error NotSeller();
    error OrderExists();
    error InvalidInput();
    error DeadlinePassed();
    error DeadlineNotPassed();
    error GasFeeTooHigh(uint256 gasFee, uint256 maxGasFee);
    error InvoiceMismatch();
    error RefundLimitReached();
    error RefundNotAllowedYet(uint256 availableAt);

    constructor(
        address token_,
        address admin_,
        uint256 baseGasUnits_,
        uint256 perItemGasUnits_,
        uint256 gasPriceRefWei_,
        uint256 musdtPerEth_
    ) {
        if (token_ == address(0) || admin_ == address(0)) revert InvalidInput();
        token = IERC20(token_);
        // admin_ = wallet arbiter; deployer juga diberi role supaya bisa menjalankan scripts/admin-tools.js
        _grantRole(DEFAULT_ADMIN_ROLE, admin_);
        _grantRole(ADMIN_ROLE, admin_);
        if (msg.sender != admin_) {
            _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
            _grantRole(ADMIN_ROLE, msg.sender);
        }
        _setGasParams(baseGasUnits_, perItemGasUnits_, gasPriceRefWei_, musdtPerEth_);
    }

    // =====================================================================
    // Buyer: deposit
    // =====================================================================

    /// @notice estimasi gas (dalam mUSDT) untuk transaksi seller pada order dengan `itemCount` baris barang
    function quoteGasFee(uint32 itemCount) public view returns (uint256) {
        uint256 units = baseGasUnits + perItemGasUnits * itemCount;
        return (units * gasPriceRefWei * musdtPerEth) / 1e18;
    }

    /// @notice buyer menyimpan harga barang + ongkir + estimasi gas ke escrow.
    ///         Butuh `approve` mUSDT ke contract ini terlebih dahulu.
    /// @param maxGasFee batas estimasi gas yang disetujui buyer di UI (melindungi dari perubahan parameter)
    function deposit(
        bytes32 orderId,
        address seller,
        uint256 itemsTotal,
        uint256 shippingFee,
        uint32 itemCount,
        uint256 maxGasFee
    ) external whenNotPaused nonReentrant {
        if (orders[orderId].status != Status.None) revert OrderExists();
        if (
            orderId == bytes32(0) || seller == address(0) || seller == msg.sender || itemsTotal == 0 ||
            itemCount == 0 || itemCount > MAX_ITEMS
        ) revert InvalidInput();

        uint256 gasFee = quoteGasFee(itemCount);
        if (gasFee > maxGasFee) revert GasFeeTooHigh(gasFee, maxGasFee);

        uint64 deadline = uint64(block.timestamp) + sellerShipWindow;
        orders[orderId] = Order({
            buyer: msg.sender,
            seller: seller,
            itemsTotal: itemsTotal,
            shippingFee: shippingFee,
            gasFee: gasFee,
            itemCount: itemCount,
            fundedAt: uint64(block.timestamp),
            shippedAt: 0,
            deliveredAt: 0,
            deadline: deadline,
            pausedRemaining: 0,
            refundCount: 0,
            refundFromShipped: false,
            status: Status.Funded
        });

        token.safeTransferFrom(msg.sender, address(this), itemsTotal + shippingFee + gasFee);
        emit Deposited(orderId, msg.sender, seller, itemsTotal, shippingFee, gasFee, deadline);
    }

    // =====================================================================
    // Seller
    // =====================================================================

    /// @notice seller menolak order sebelum kirim, semua dana kembali ke buyer
    function sellerCancel(bytes32 orderId) external nonReentrant {
        Order storage o = orders[orderId];
        if (msg.sender != o.seller) revert NotSeller();
        if (o.status != Status.Funded) revert InvalidStatus(o.status);
        _cancel(orderId, o, CancelReason.SellerRejected);
    }

    /// @notice seller menyerahkan barang ke kurir dan mencatat invoice on-chain
    function markShipped(
        bytes32 orderId,
        string calldata invoiceId,
        InvoiceItem[] calldata items,
        string calldata courier,
        string calldata trackingNumber
    ) external {
        Order storage o = orders[orderId];
        if (msg.sender != o.seller) revert NotSeller();
        if (o.status != Status.Funded) revert InvalidStatus(o.status);
        if (block.timestamp > o.deadline) revert DeadlinePassed();
        if (bytes(invoiceId).length == 0 || bytes(trackingNumber).length == 0 || bytes(courier).length == 0) {
            revert InvalidInput();
        }
        if (items.length != o.itemCount) revert InvoiceMismatch();

        uint256 sum;
        for (uint256 i = 0; i < items.length; i++) {
            if (items[i].qty == 0 || bytes(items[i].name).length == 0) revert InvoiceMismatch();
            sum += items[i].qty * items[i].unitPrice;
        }
        if (sum != o.itemsTotal) revert InvoiceMismatch();

        o.status = Status.Shipped;
        o.shippedAt = uint64(block.timestamp);
        o.deadline = 0;

        emit Shipped(orderId, block.timestamp);
        emit InvoiceRecorded(
            orderId,
            invoiceId,
            o.seller,
            o.buyer,
            items,
            o.itemsTotal,
            o.shippingFee,
            o.gasFee,
            o.itemsTotal + o.shippingFee + o.gasFee,
            courier,
            trackingNumber,
            o.fundedAt,
            o.shippedAt
        );
    }

    /// @notice seller menandai barang sudah sampai di buyer, timer buyer mulai berjalan
    function markDelivered(bytes32 orderId) external {
        Order storage o = orders[orderId];
        if (msg.sender != o.seller) revert NotSeller();
        if (o.status != Status.Shipped) revert InvalidStatus(o.status);

        o.status = Status.Delivered;
        o.deliveredAt = uint64(block.timestamp);
        o.deadline = uint64(block.timestamp) + buyerConfirmWindow;
        emit Delivered(orderId, o.deadline);
    }

    /// @notice seller mengonfirmasi retur sudah diterima, refund dicairkan ke buyer
    function confirmReturnReceived(bytes32 orderId) external nonReentrant {
        Order storage o = orders[orderId];
        if (msg.sender != o.seller) revert NotSeller();
        if (o.status != Status.ReturnShipped && o.status != Status.ReturnDelivered) revert InvalidStatus(o.status);
        _refund(orderId, o, false);
    }

    // =====================================================================
    // Buyer
    // =====================================================================

    /// @notice buyer menerima barang, dana (barang + ongkir + estimasi gas) cair ke seller
    function confirmReceived(bytes32 orderId) external nonReentrant {
        Order storage o = orders[orderId];
        if (msg.sender != o.buyer) revert NotBuyer();
        if (o.status != Status.Delivered) revert InvalidStatus(o.status);
        _complete(orderId, o, false);
    }

    /// @notice buyer mengajukan refund (maksimal 3x per order).
    ///         - status Delivered: selama timer buyer belum habis, timer di-pause
    ///         - status Shipped: hanya jika sudah lewat `notDeliveredWindow` sejak ship (barang tak kunjung sampai)
    function requestRefund(bytes32 orderId) external {
        Order storage o = orders[orderId];
        if (msg.sender != o.buyer) revert NotBuyer();
        if (o.refundCount >= MAX_REFUND_REQUESTS) revert RefundLimitReached();

        if (o.status == Status.Delivered) {
            if (block.timestamp > o.deadline) revert DeadlinePassed();
            o.pausedRemaining = o.deadline - uint64(block.timestamp);
            o.refundFromShipped = false;
        } else if (o.status == Status.Shipped) {
            uint256 availableAt = uint256(o.shippedAt) + notDeliveredWindow;
            if (block.timestamp < availableAt) revert RefundNotAllowedYet(availableAt);
            o.pausedRemaining = 0;
            o.refundFromShipped = true;
        } else {
            revert InvalidStatus(o.status);
        }

        o.refundCount += 1;
        o.status = Status.RefundRequested;
        o.deadline = 0;
        emit RefundRequested(orderId, o.refundCount, o.refundFromShipped);
    }

    /// @notice buyer menyerahkan barang retur ke kurir (maksimal `returnShipWindow` sejak refund disetujui)
    function markReturnShipped(bytes32 orderId) external {
        Order storage o = orders[orderId];
        if (msg.sender != o.buyer) revert NotBuyer();
        if (o.status != Status.ReturnPending) revert InvalidStatus(o.status);
        if (block.timestamp > o.deadline) revert DeadlinePassed();

        o.status = Status.ReturnShipped;
        o.deadline = 0;
        emit ReturnShipped(orderId);
    }

    /// @notice buyer menandai retur sudah sampai di seller, timer seller mulai berjalan
    function markReturnDelivered(bytes32 orderId) external {
        Order storage o = orders[orderId];
        if (msg.sender != o.buyer) revert NotBuyer();
        if (o.status != Status.ReturnShipped) revert InvalidStatus(o.status);

        o.status = Status.ReturnDelivered;
        o.deadline = uint64(block.timestamp) + returnConfirmWindow;
        emit ReturnDelivered(orderId, o.deadline);
    }

    // =====================================================================
    // Admin (= arbiter)
    // =====================================================================

    function approveRefund(bytes32 orderId) external onlyRole(ADMIN_ROLE) nonReentrant {
        Order storage o = orders[orderId];
        if (o.status != Status.RefundRequested) revert InvalidStatus(o.status);

        if (o.refundFromShipped) {
            // barang tak pernah sampai: tidak ada retur, dana langsung dikembalikan
            emit RefundApproved(orderId, false, 0);
            _refund(orderId, o, false);
            return;
        }

        o.status = Status.ReturnPending;
        o.deadline = uint64(block.timestamp) + returnShipWindow;
        o.pausedRemaining = 0;
        emit RefundApproved(orderId, true, o.deadline);
    }

    /// @notice refund ditolak: order kembali ke tahap sebelumnya, timer buyer lanjut dari sisa waktu
    function rejectRefund(bytes32 orderId) external onlyRole(ADMIN_ROLE) {
        Order storage o = orders[orderId];
        if (o.status != Status.RefundRequested) revert InvalidStatus(o.status);

        if (o.refundFromShipped) {
            o.status = Status.Shipped;
            o.deadline = 0;
        } else {
            o.status = Status.Delivered;
            o.deadline = uint64(block.timestamp) + o.pausedRemaining;
        }
        o.pausedRemaining = 0;
        o.refundFromShipped = false;
        emit RefundRejected(orderId, o.deadline);
    }

    function setGasParams(
        uint256 baseGasUnits_,
        uint256 perItemGasUnits_,
        uint256 gasPriceRefWei_,
        uint256 musdtPerEth_
    ) external onlyRole(ADMIN_ROLE) {
        _setGasParams(baseGasUnits_, perItemGasUnits_, gasPriceRefWei_, musdtPerEth_);
    }

    function setWindows(
        uint64 sellerShip,
        uint64 buyerConfirm,
        uint64 returnShip,
        uint64 returnConfirm,
        uint64 notDelivered
    ) external onlyRole(ADMIN_ROLE) {
        if (
            sellerShip == 0 || buyerConfirm == 0 || returnShip == 0 || returnConfirm == 0 || notDelivered == 0 ||
            sellerShip > MAX_WINDOW || buyerConfirm > MAX_WINDOW || returnShip > MAX_WINDOW ||
            returnConfirm > MAX_WINDOW || notDelivered > MAX_WINDOW
        ) revert InvalidInput();

        sellerShipWindow = sellerShip;
        buyerConfirmWindow = buyerConfirm;
        returnShipWindow = returnShip;
        returnConfirmWindow = returnConfirm;
        notDeliveredWindow = notDelivered;
        emit WindowsUpdated(sellerShip, buyerConfirm, returnShip, returnConfirm, notDelivered);
    }

    /// @notice pause hanya menghentikan deposit baru; order berjalan tetap bisa diselesaikan
    function pause() external onlyRole(ADMIN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(ADMIN_ROLE) {
        _unpause();
    }

    // =====================================================================
    // Auto (siapa saja boleh panggil, contract yang mengecek batas waktu)
    // =====================================================================

    /// @notice seller tidak ship dalam batas waktu -> order batal, semua dana ke buyer
    function autoCancel(bytes32 orderId) external nonReentrant {
        Order storage o = orders[orderId];
        if (o.status != Status.Funded) revert InvalidStatus(o.status);
        if (block.timestamp <= o.deadline) revert DeadlineNotPassed();
        _cancel(orderId, o, CancelReason.ShipDeadlinePassed);
    }

    /// @notice buyer tidak merespons dalam batas waktu -> otomatis diterima, dana ke seller
    function autoRelease(bytes32 orderId) external nonReentrant {
        Order storage o = orders[orderId];
        if (o.status != Status.Delivered) revert InvalidStatus(o.status);
        if (block.timestamp <= o.deadline) revert DeadlineNotPassed();
        _complete(orderId, o, true);
    }

    /// @notice buyer tidak mengirim retur dalam batas waktu -> refund batal, dana ke seller
    function expireReturn(bytes32 orderId) external nonReentrant {
        Order storage o = orders[orderId];
        if (o.status != Status.ReturnPending) revert InvalidStatus(o.status);
        if (block.timestamp <= o.deadline) revert DeadlineNotPassed();
        emit ReturnExpired(orderId);
        _complete(orderId, o, true);
    }

    /// @notice seller tidak konfirmasi retur dalam batas waktu -> refund otomatis ke buyer
    function autoRefund(bytes32 orderId) external nonReentrant {
        Order storage o = orders[orderId];
        if (o.status != Status.ReturnDelivered) revert InvalidStatus(o.status);
        if (block.timestamp <= o.deadline) revert DeadlineNotPassed();
        _refund(orderId, o, true);
    }

    // =====================================================================
    // Views
    // =====================================================================

    function getOrder(bytes32 orderId) external view returns (Order memory) {
        return orders[orderId];
    }

    /// @notice aksi otomatis yang sudah bisa dijalankan untuk order ini:
    ///         0 = tidak ada, 1 = autoCancel, 2 = autoRelease, 3 = expireReturn, 4 = autoRefund
    function pendingAutoAction(bytes32 orderId) external view returns (uint8) {
        Order storage o = orders[orderId];
        if (o.deadline == 0 || block.timestamp <= o.deadline) return 0;
        if (o.status == Status.Funded) return 1;
        if (o.status == Status.Delivered) return 2;
        if (o.status == Status.ReturnPending) return 3;
        if (o.status == Status.ReturnDelivered) return 4;
        return 0;
    }

    // =====================================================================
    // Internal
    // =====================================================================

    function _cancel(bytes32 orderId, Order storage o, CancelReason reason) private {
        uint256 amount = o.itemsTotal + o.shippingFee + o.gasFee;
        o.status = Status.Cancelled;
        o.deadline = 0;
        token.safeTransfer(o.buyer, amount);
        emit OrderCancelled(orderId, reason, amount);
    }

    function _complete(bytes32 orderId, Order storage o, bool automatic) private {
        uint256 amount = o.itemsTotal + o.shippingFee + o.gasFee;
        o.status = Status.Completed;
        o.deadline = 0;
        token.safeTransfer(o.seller, amount);
        emit Completed(orderId, amount, automatic);
    }

    function _refund(bytes32 orderId, Order storage o, bool automatic) private {
        uint256 toBuyer = o.itemsTotal + o.shippingFee;
        uint256 toSeller = o.gasFee;
        o.status = Status.Refunded;
        o.deadline = 0;
        token.safeTransfer(o.buyer, toBuyer);
        if (toSeller > 0) token.safeTransfer(o.seller, toSeller);
        emit Refunded(orderId, toBuyer, toSeller, automatic);
    }

    function _setGasParams(
        uint256 baseGasUnits_,
        uint256 perItemGasUnits_,
        uint256 gasPriceRefWei_,
        uint256 musdtPerEth_
    ) private {
        if (baseGasUnits_ == 0 || gasPriceRefWei_ == 0 || musdtPerEth_ == 0) revert InvalidInput();
        baseGasUnits = baseGasUnits_;
        perItemGasUnits = perItemGasUnits_;
        gasPriceRefWei = gasPriceRefWei_;
        musdtPerEth = musdtPerEth_;
        emit GasParamsUpdated(baseGasUnits_, perItemGasUnits_, gasPriceRefWei_, musdtPerEth_);
    }
}
