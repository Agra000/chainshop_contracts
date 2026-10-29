// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title MockUSDT (mUSDT)
/// @notice Token tiruan USDT KHUSUS TESTNET (Sepolia). Tidak punya nilai uang sama sekali.
///         6 desimal seperti USDT asli. Siapa saja boleh klaim dari faucet dengan batas
///         FAUCET_AMOUNT per FAUCET_COOLDOWN per wallet.
contract MockUSDT is ERC20, Ownable {
    uint256 public constant FAUCET_AMOUNT = 10_000 * 10 ** 6; // 10.000 mUSDT
    uint256 public constant FAUCET_COOLDOWN = 24 hours;

    /// @notice waktu (unix) terakhir sebuah wallet klaim faucet
    mapping(address => uint256) public lastFaucetClaim;

    event FaucetClaimed(address indexed to, uint256 amount);

    error FaucetCooldown(uint256 availableAt);

    constructor() ERC20("Mock USDT (Testnet, no value)", "mUSDT") Ownable(msg.sender) {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice klaim 10.000 mUSDT, maksimal 1x per 24 jam per wallet
    function faucet() external {
        uint256 availableAt = nextFaucetAt(msg.sender);
        if (block.timestamp < availableAt) revert FaucetCooldown(availableAt);

        lastFaucetClaim[msg.sender] = block.timestamp;
        _mint(msg.sender, FAUCET_AMOUNT);
        emit FaucetClaimed(msg.sender, FAUCET_AMOUNT);
    }

    /// @notice kapan wallet ini boleh klaim lagi (0 = sekarang juga boleh)
    function nextFaucetAt(address account) public view returns (uint256) {
        uint256 last = lastFaucetClaim[account];
        return last == 0 ? 0 : last + FAUCET_COOLDOWN;
    }

    /// @notice mint manual oleh owner (deployer), misalnya untuk wallet demo
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
}
