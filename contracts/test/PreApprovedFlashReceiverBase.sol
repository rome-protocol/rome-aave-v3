// SPDX-License-Identifier: MIT
pragma solidity ^0.8.10;

import {IFlashLoanReceiver} from "../misc/flashloan/interfaces/IFlashLoanReceiver.sol";
import {IPool} from "../interfaces/IPool.sol";
import {IPoolAddressesProvider} from "../interfaces/IPoolAddressesProvider.sol";

/// @notice Abstract base for Aave V3 multi-asset flash loan receivers on Rome.
/// @dev See `CLAUDE.md § "Multi-asset Flash Loan Pattern"` for the Rome rationale.
///
/// Why this pattern exists:
///
/// Canonical Aave V3 flash loan receivers do `IERC20(asset).approve(Pool, ...)`
/// inside `executeOperation()`. On Rome that in-callback approve adds the SPL
/// `approve_checked` CPI's accounts (~7-10 unique) to the flash loan tx's
/// account set. For multi-asset Pool.flashLoan with 2+ cached SPL wrappers,
/// that overflow pushes the per-sig account count past the cached-wrapper
/// composition limit (empirically 62-65 accounts on Solana mainnet's runtime
/// account_locks cap; devnet's 128 is more permissive).
///
/// This base contract moves the approve OUT of executeOperation: owner calls
/// `init(assets)` ONCE before any flash loan, pre-approving Pool to MaxUint256
/// on each cached wrapper. Subsequent Pool.flashLoan calls then have no
/// in-callback approve to add accounts to the per-sig set. Empirically lands
/// 2-cached-wrapper multi-asset flash loan at ~60 accounts/sig vs ~67+ with
/// in-callback approve.
///
/// Security hardening baked into the base:
///
///   - `executeOperation()` validates `msg.sender == address(POOL)` (rejects
///     spoofed callbacks from non-Pool addresses).
///   - `executeOperation()` validates `authorizedInitiator[initiator] == true`
///     (rejects unauthorized Pool.flashLoan calls — anyone can call
///     Pool.flashLoan against this receiver, but only whitelisted initiators
///     trigger app logic; un-whitelisted callers cause executeOperation to
///     revert, refunding any tokens Pool sent forward).
///   - `init()` / `revoke()` / `sweep()` / `setInitiator()` all gated by
///     `onlyOwner` — operator-controlled lifecycle.
///   - `revoke()` lets the operator zero out approvals for clean decommission.
///   - `sweep()` lets the operator recover stuck tokens (e.g., over-funded
///     premium that wasn't consumed).
///
/// App-specific logic goes in `_executeOperation` (internal virtual). The
/// inheriting contract has the loaned tokens in hand by the time _executeOp
/// runs and must ensure repayment funds are available (`amount + premium` per
/// asset). No `approve` call needed inside `_executeOperation`.
abstract contract PreApprovedFlashReceiverBase is IFlashLoanReceiver {
    IPoolAddressesProvider public immutable override ADDRESSES_PROVIDER;
    IPool public immutable override POOL;

    address public owner;
    mapping(address => bool) public authorizedInitiator;

    error NotOwner();
    error NotPool();
    error NotAuthorizedInitiator(address initiator);
    error OperationFailed();
    error InvalidNewOwner();

    event OwnerTransferred(address indexed previous, address indexed next);
    event InitiatorAuthorized(address indexed who, bool allowed);
    event AssetApproved(address indexed asset, uint256 allowance);
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
        authorizedInitiator[msg.sender] = true;
        emit OwnerTransferred(address(0), msg.sender);
        emit InitiatorAuthorized(msg.sender, true);
    }

    /// @notice Pre-approve Pool for MaxUint256 on each asset. Call once after
    /// deploy, before any Pool.flashLoan against this receiver.
    /// @dev Each iteration writes the SPL delegate state for that asset's
    /// wrapper. Because this is in a separate tx from Pool.flashLoan, the
    /// approve's accounts don't accumulate in the flash loan tx's account set.
    function init(address[] calldata assets) external onlyOwner {
        for (uint256 i = 0; i < assets.length; i++) {
            IERC20Minimal(assets[i]).approve(address(POOL), type(uint256).max);
            emit AssetApproved(assets[i], type(uint256).max);
        }
    }

    /// @notice Zero out approvals for a set of assets. Use when decommissioning
    /// the receiver or rotating off a deprecated wrapper.
    function revoke(address[] calldata assets) external onlyOwner {
        for (uint256 i = 0; i < assets.length; i++) {
            IERC20Minimal(assets[i]).approve(address(POOL), 0);
            emit AssetRevoked(assets[i]);
        }
    }

    /// @notice Add/remove an initiator from the whitelist. The whitelist gates
    /// who can trigger `_executeOperation` via Pool.flashLoan — anyone can call
    /// Pool.flashLoan with this receiver, but only whitelisted initiators
    /// produce a successful execution; others revert (no funds leave Pool).
    function setInitiator(address who, bool allowed) external onlyOwner {
        authorizedInitiator[who] = allowed;
        emit InitiatorAuthorized(who, allowed);
    }

    /// @notice Transfer ownership. Old owner remains whitelisted as an
    /// initiator unless explicitly removed via `setInitiator(oldOwner, false)`.
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert InvalidNewOwner();
        address prev = owner;
        owner = newOwner;
        authorizedInitiator[newOwner] = true;
        emit OwnerTransferred(prev, newOwner);
        emit InitiatorAuthorized(newOwner, true);
    }

    /// @notice Recover tokens stranded in the receiver — over-funded premium,
    /// mistakenly-sent tokens, etc.
    function sweep(address asset, address to, uint256 amount) external onlyOwner {
        IERC20Minimal(asset).transfer(to, amount);
        emit Swept(asset, to, amount);
    }

    /// @notice Pool's flash-loan callback. Validates the caller is Pool and
    /// the initiator is whitelisted, then delegates to `_executeOperation` for
    /// app-specific logic. Inheriting contracts override `_executeOperation`.
    function executeOperation(
        address[] calldata assets,
        uint256[] calldata amounts,
        uint256[] calldata premiums,
        address initiator,
        bytes calldata params
    ) external override returns (bool) {
        if (msg.sender != address(POOL)) revert NotPool();
        if (!authorizedInitiator[initiator]) revert NotAuthorizedInitiator(initiator);
        bool ok = _executeOperation(assets, amounts, premiums, initiator, params);
        if (!ok) revert OperationFailed();
        return true;
    }

    /// @notice App-specific flash loan body. By the time this is called, the
    /// receiver holds `amounts[i]` of `assets[i]` for each i. Implementor MUST
    /// ensure the receiver holds at least `amounts[i] + premiums[i]` by the
    /// time `_executeOperation` returns — Pool will pull that amount back via
    /// the pre-approved allowance set by `init()`.
    function _executeOperation(
        address[] calldata assets,
        uint256[] calldata amounts,
        uint256[] calldata premiums,
        address initiator,
        bytes calldata params
    ) internal virtual returns (bool);
}

interface IERC20Minimal {
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}
