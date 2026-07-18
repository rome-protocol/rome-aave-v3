// SPDX-License-Identifier: MIT
pragma solidity ^0.8.10;

import {IFlashLoanReceiver} from "../misc/flashloan/interfaces/IFlashLoanReceiver.sol";
import {IPool} from "../interfaces/IPool.sol";
import {IPoolAddressesProvider} from "../interfaces/IPoolAddressesProvider.sol";

/// @notice DEMO-ONLY pre-approved multi-asset flash loan receiver.
/// @dev DO NOT use this contract on mainnet or production. It deliberately has
/// no initiator whitelist — anyone can call `Pool.flashLoan(thisReceiver, ...)`
/// from any wallet, and `executeOperation` will return true and let Pool pull
/// back the loan + premium. That makes this contract a public flash-loan-as-a-
/// service: if it holds premium funding, anyone can burn it.
///
/// For production multi-asset flash loan receivers use
/// `PreApprovedFlashReceiverBase` (same directory) which enforces an initiator
/// whitelist via `authorizedInitiator`.
///
/// This contract exists so the rome-aave-v3-demo's public `/flashloan` UI can
/// expose a multi-asset flash loan flow that any visitor can click without
/// the demo backend needing to whitelist their wallet first. The demo funds
/// the receiver with premium per-call and accepts the brief griefing window
/// (where another caller could race to burn the premium between funding and
/// the flashLoan call) as a known demo-quality limitation.
///
/// Init pattern matches `PreApprovedFlashReceiverBase`: owner calls
/// `init(assets)` once to pre-approve Pool MaxUint256 on each cached wrapper.
/// After init, anyone can invoke Pool.flashLoan against this receiver.
contract DemoOpenMultiFlashReceiver is IFlashLoanReceiver {
    IPoolAddressesProvider public immutable override ADDRESSES_PROVIDER;
    IPool public immutable override POOL;

    address public owner;

    error NotOwner();
    error NotPool();

    event Operation(address[] assets, uint256[] amounts, uint256[] premiums, address initiator);
    event AssetApproved(address indexed asset);
    event AssetRevoked(address indexed asset);
    event Swept(address indexed asset, address indexed to, uint256 amount);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(IPoolAddressesProvider provider) {
        ADDRESSES_PROVIDER = provider;
        POOL = IPool(provider.getPool());
        owner = msg.sender;
    }

    /// Pre-approve Pool for MaxUint256 on each asset. Demo deployer calls once.
    function init(address[] calldata assets) external onlyOwner {
        for (uint256 i = 0; i < assets.length; i++) {
            IERC20Minimal(assets[i]).approve(address(POOL), type(uint256).max);
            emit AssetApproved(assets[i]);
        }
    }

    /// Zero out approvals when decommissioning.
    function revoke(address[] calldata assets) external onlyOwner {
        for (uint256 i = 0; i < assets.length; i++) {
            IERC20Minimal(assets[i]).approve(address(POOL), 0);
            emit AssetRevoked(assets[i]);
        }
    }

    /// Recover stuck tokens — over-funded premium, accidental transfers, etc.
    function sweep(address asset, address to, uint256 amount) external onlyOwner {
        IERC20Minimal(asset).transfer(to, amount);
        emit Swept(asset, to, amount);
    }

    /// Pool's callback. Validates Pool only; deliberately NO initiator check.
    function executeOperation(
        address[] calldata assets,
        uint256[] calldata amounts,
        uint256[] calldata premiums,
        address initiator,
        bytes calldata
    ) external override returns (bool) {
        if (msg.sender != address(POOL)) revert NotPool();
        emit Operation(assets, amounts, premiums, initiator);
        return true;
    }
}

interface IERC20Minimal {
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}
