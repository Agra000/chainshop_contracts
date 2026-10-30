// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

/// @title ChainShopEscrow (v3, hemat gas)
/// @notice Rekber B2B ChainShop di Sepolia memakai Mock USDT (tanpa nilai uang asli).
///         Contract ini HANYA menangani aksi yang memindahkan uang + pencatatan invoice:
///           deposit  -> markShipped (invoice onchain) -> release (ke seller) / refund (ke buyer)
///         v3: buyer menerima barang cukup dengan TANDA TANGAN EIP-712 (gratis, tanpa gas);
///         seller lalu mengklaim dana sendiri lewat releaseWithAcceptance (gas dibayar seller).
///         Status lain (barang sampai, pengajuan refund, retur, timer 3 hari, batas 3x refund)
///         dikelola backend (off-chain) supaya buyer, seller, dan admin tidak membayar gas berulang.
///         Contract tetap menjamin: uang hanya bisa ke buyer/seller order tersebut, dengan jumlah tetap,
///         dan hanya sekali (tidak bisa dicairkan dua kali).
contract ChainShopEscrow is AccessControl, Pausable, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    /// @notice admin = arbiter refund (approve refund barang tak sampai), atur parameter, pause
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    /// @notice wallet backend (cron): auto release / auto refund sesuai timer off-chain
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");

    /// @notice struct EIP-712 yang ditandatangani buyer saat menerima barang
    bytes32 public constant ACCEPTANCE_TYPEHASH =
        keccak256("Acceptance(bytes32 orderId,address buyer,address seller,uint256 amount)");

    uint32 public constant MAX_ITEMS = 50;
    uint64 public constant MAX_WINDOW = 90 days;

    enum Status {
        None, //      0 belum ada
        Funded, //    1 buyer sudah deposit, menunggu seller kirim
        Shipped, //   2 seller kirim + invoice tercatat
        Completed, // 3 dana dilepas ke seller
        Refunded, //  4 refund setelah dikirim: barang + ongkir ke buyer, estimasi gas ke seller
        Cancelled //  5 batal sebelum dikirim: semua dana kembali ke buyer
    }

    struct Order {
        address buyer;
        address seller;
        uint256 itemsTotal; // total harga barang (6 desimal)
        uint256 shippingFee; // ongkir (6 desimal)
        uint256 gasFee; // estimasi gas transaksi seller (markShipped + klaim dana), 6 desimal
        uint32 itemCount; // jumlah baris barang di invoice
        uint64 fundedAt;
        uint64 shipDeadline; // batas seller kirim
        uint64 shippedAt;
        Status status;
    }

    struct InvoiceItem {
        string name;
        uint256 qty;
        uint256 unitPrice; // 6 desimal
    }

    IERC20 public immutable token;
    mapping(bytes32 => Order) public orders;

    /// @notice deposit -> batas seller kirim (lewat = buyer bisa tarik dana sendiri)
    uint64 public sellerShipWindow = 3 days;
    /// @notice pintu darurat: jika backend tidak memutuskan apa pun selama ini sejak dikirim, seller bisa klaim
    uint64 public sellerClaimWindow = 30 days;

    // gasFee (mUSDT, 6 desimal) = (baseGasUnits + perItemGasUnits * itemCount) * gasPriceRefWei * musdtPerEth / 1e18
    uint256 public baseGasUnits;
    uint256 public perItemGasUnits;
    uint256 public gasPriceRefWei;
    uint256 public musdtPerEth; // unit mUSDT (6 desimal) per 1 ETH, kurs fixed

    event Deposited(
        bytes32 indexed orderId,
        address indexed buyer,
        address indexed seller,
        uint256 itemsTotal,
        uint256 shippingFee,
        uint256 gasFee,
        uint256 shipDeadline
    );
    event OrderCancelled(bytes32 indexed orderId, uint256 refundedToBuyer, address indexed by);
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
    event Released(bytes32 indexed orderId, uint256 paidToSeller, address indexed by);
    event Refunded(bytes32 indexed orderId, uint256 toBuyer, uint256 toSeller, address indexed by);
    event GasParamsUpdated(uint256 baseGasUnits, uint256 perItemGasUnits, uint256 gasPriceRefWei, uint256 musdtPerEth);
    event WindowsUpdated(uint64 sellerShipWindow, uint64 sellerClaimWindow);

    error InvalidStatus(Status current);
    error NotAllowed();
    error NotSeller();
    error OrderExists();
    error InvalidInput();
    error DeadlinePassed();
    error DeadlineNotPassed();
    error GasFeeTooHigh(uint256 gasFee, uint256 maxGasFee);
    error InvoiceMismatch();
    error InvalidSignature();

    constructor(
        address token_,
        address admin_,
        address operator_,
        uint256 baseGasUnits_,
        uint256 perItemGasUnits_,
        uint256 gasPriceRefWei_,
        uint256 musdtPerEth_
    ) EIP712("ChainShopEscrow", "1") {
        if (token_ == address(0) || admin_ == address(0)) revert InvalidInput();
        token = IERC20(token_);

        _grantRole(DEFAULT_ADMIN_ROLE, admin_);
        _grantRole(ADMIN_ROLE, admin_);
        // deployer juga admin supaya bisa menjalankan scripts/admin-tools.js
        if (msg.sender != admin_) {
            _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
            _grantRole(ADMIN_ROLE, msg.sender);
        }
        if (operator_ != address(0)) _grantRole(OPERATOR_ROLE, operator_);

        _setGasParams(baseGasUnits_, perItemGasUnits_, gasPriceRefWei_, musdtPerEth_);
    }

    // =====================================================================
    // Buyer: deposit
    // =====================================================================

    /// @notice estimasi gas (mUSDT) untuk transaksi seller (markShipped + releaseWithAcceptance)
    ///         dengan `itemCount` baris barang
    function quoteGasFee(uint32 itemCount) public view returns (uint256) {
        uint256 units = baseGasUnits + perItemGasUnits * itemCount;
        return (units * gasPriceRefWei * musdtPerEth) / 1e18;
    }

    /// @notice buyer menyimpan harga barang + ongkir + estimasi gas ke escrow (butuh approve mUSDT)
    /// @param maxGasFee batas estimasi gas yang disetujui buyer di UI
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
            shipDeadline: deadline,
            shippedAt: 0,
            status: Status.Funded
        });

        token.safeTransferFrom(msg.sender, address(this), itemsTotal + shippingFee + gasFee);
        emit Deposited(orderId, msg.sender, seller, itemsTotal, shippingFee, gasFee, deadline);
    }

    // =====================================================================
    // Seller: kirim + invoice
    // =====================================================================

    /// @notice seller menyerahkan barang ke kurir dan mencatat invoice onchain (satu-satunya tx seller di alur normal)
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
        if (block.timestamp > o.shipDeadline) revert DeadlinePassed();
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

    // =====================================================================
    // Pencairan dana
    // =====================================================================

    /// @notice dana (barang + ongkir + estimasi gas) dilepas ke seller.
    ///         Buyer: saat menerima barang. Operator/admin: auto release (timer off-chain habis / retur tidak dikirim).
    function release(bytes32 orderId) external nonReentrant {
        Order storage o = orders[orderId];
        if (o.status != Status.Shipped) revert InvalidStatus(o.status);
        if (msg.sender != o.buyer && !_isOperatorOrAdmin(msg.sender)) revert NotAllowed();
        _release(orderId, o);
    }

    /// @notice seller (atau operator/admin) mencairkan dana memakai tanda tangan persetujuan buyer.
    ///         Buyer tidak membayar gas: ia hanya menandatangani pesan EIP-712 `Acceptance` di MetaMask.
    ///         Tanpa tanda tangan buyer yang valid, seller tetap tidak bisa mencairkan dana.
    function releaseWithAcceptance(bytes32 orderId, bytes calldata signature) external nonReentrant {
        Order storage o = orders[orderId];
        if (o.status != Status.Shipped) revert InvalidStatus(o.status);
        if (msg.sender != o.seller && !_isOperatorOrAdmin(msg.sender)) revert NotAllowed();
        if (!SignatureChecker.isValidSignatureNow(o.buyer, _acceptanceDigest(orderId, o), signature)) {
            revert InvalidSignature();
        }
        _release(orderId, o);
    }

    /// @notice dana dikembalikan ke buyer.
    ///         - sebelum dikirim (Funded): semua dana ke buyer (seller tolak / auto cancel).
    ///         - setelah dikirim (Shipped): barang + ongkir ke buyer, estimasi gas ke seller
    ///           (seller konfirmasi retur, admin approve refund barang tak sampai, operator auto refund).
    ///         Boleh dipanggil seller order tersebut, operator, atau admin.
    function refund(bytes32 orderId) external nonReentrant {
        Order storage o = orders[orderId];
        if (msg.sender != o.seller && !_isOperatorOrAdmin(msg.sender)) revert NotAllowed();

        if (o.status == Status.Funded) {
            _cancel(orderId, o);
        } else if (o.status == Status.Shipped) {
            _refund(orderId, o);
        } else {
            revert InvalidStatus(o.status);
        }
    }

    // =====================================================================
    // Pintu darurat (tidak bergantung pada backend)
    // =====================================================================

    /// @notice seller tidak mengirim sebelum batas waktu -> siapa saja bisa membatalkan, semua dana ke buyer
    function cancelExpired(bytes32 orderId) external nonReentrant {
        Order storage o = orders[orderId];
        if (o.status != Status.Funded) revert InvalidStatus(o.status);
        if (block.timestamp <= o.shipDeadline) revert DeadlineNotPassed();
        _cancel(orderId, o);
    }

    /// @notice backend tidak memutuskan apa pun lama sekali setelah dikirim -> seller bisa klaim dana
    function claimStale(bytes32 orderId) external nonReentrant {
        Order storage o = orders[orderId];
        if (msg.sender != o.seller) revert NotSeller();
        if (o.status != Status.Shipped) revert InvalidStatus(o.status);
        if (block.timestamp <= uint256(o.shippedAt) + sellerClaimWindow) revert DeadlineNotPassed();
        _release(orderId, o);
    }

    // =====================================================================
    // Admin
    // =====================================================================

    function setGasParams(
        uint256 baseGasUnits_,
        uint256 perItemGasUnits_,
        uint256 gasPriceRefWei_,
        uint256 musdtPerEth_
    ) external onlyRole(ADMIN_ROLE) {
        _setGasParams(baseGasUnits_, perItemGasUnits_, gasPriceRefWei_, musdtPerEth_);
    }

    function setWindows(uint64 sellerShip, uint64 sellerClaim) external onlyRole(ADMIN_ROLE) {
        if (sellerShip == 0 || sellerClaim == 0 || sellerShip > MAX_WINDOW || sellerClaim > MAX_WINDOW) {
            revert InvalidInput();
        }
        sellerShipWindow = sellerShip;
        sellerClaimWindow = sellerClaim;
        emit WindowsUpdated(sellerShip, sellerClaim);
    }

    /// @notice pause hanya menghentikan deposit baru; order berjalan tetap bisa diselesaikan
    function pause() external onlyRole(ADMIN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(ADMIN_ROLE) {
        _unpause();
    }

    // =====================================================================
    // Views
    // =====================================================================

    function getOrder(bytes32 orderId) external view returns (Order memory) {
        return orders[orderId];
    }

    function isOperatorOrAdmin(address account) external view returns (bool) {
        return _isOperatorOrAdmin(account);
    }

    /// @notice digest EIP-712 yang harus ditandatangani buyer untuk order ini
    function acceptanceDigest(bytes32 orderId) external view returns (bytes32) {
        return _acceptanceDigest(orderId, orders[orderId]);
    }

    /// @notice dipakai backend untuk memverifikasi tanda tangan buyer sebelum disimpan
    function isValidAcceptance(bytes32 orderId, bytes calldata signature) external view returns (bool) {
        Order storage o = orders[orderId];
        if (o.buyer == address(0)) return false;
        return SignatureChecker.isValidSignatureNow(o.buyer, _acceptanceDigest(orderId, o), signature);
    }

    // =====================================================================
    // Internal
    // =====================================================================

    function _isOperatorOrAdmin(address account) private view returns (bool) {
        return hasRole(OPERATOR_ROLE, account) || hasRole(ADMIN_ROLE, account);
    }

    function _acceptanceDigest(bytes32 orderId, Order storage o) private view returns (bytes32) {
        uint256 amount = o.itemsTotal + o.shippingFee + o.gasFee;
        return _hashTypedDataV4(keccak256(abi.encode(ACCEPTANCE_TYPEHASH, orderId, o.buyer, o.seller, amount)));
    }

    function _cancel(bytes32 orderId, Order storage o) private {
        uint256 amount = o.itemsTotal + o.shippingFee + o.gasFee;
        o.status = Status.Cancelled;
        token.safeTransfer(o.buyer, amount);
        emit OrderCancelled(orderId, amount, msg.sender);
    }

    function _release(bytes32 orderId, Order storage o) private {
        uint256 amount = o.itemsTotal + o.shippingFee + o.gasFee;
        o.status = Status.Completed;
        token.safeTransfer(o.seller, amount);
        emit Released(orderId, amount, msg.sender);
    }

    function _refund(bytes32 orderId, Order storage o) private {
        uint256 toBuyer = o.itemsTotal + o.shippingFee;
        uint256 toSeller = o.gasFee;
        o.status = Status.Refunded;
        token.safeTransfer(o.buyer, toBuyer);
        if (toSeller > 0) token.safeTransfer(o.seller, toSeller);
        emit Refunded(orderId, toBuyer, toSeller, msg.sender);
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
