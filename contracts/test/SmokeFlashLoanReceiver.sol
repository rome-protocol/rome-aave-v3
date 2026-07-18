// SPDX-License-Identifier: MIT
pragma solidity ^0.8.10;

import {IFlashLoanSimpleReceiver} from "../misc/flashloan/interfaces/IFlashLoanSimpleReceiver.sol";
import {IPool} from "../interfaces/IPool.sol";
import {IPoolAddressesProvider} from "../interfaces/IPoolAddressesProvider.sol";

// Minimal flash loan receiver for the rome-aave-v3 gamut.
// `executeOperation` approves the Pool to pull (amount + premium) back —
// the contract MUST hold (amount + premium) of `asset` at that point.
// The deployer funds the receiver with the premium ahead of the flashLoanSimple
// call; the loaned `amount` is delivered by the Pool directly to this contract
// before executeOperation runs.
contract SmokeFlashLoanReceiver is IFlashLoanSimpleReceiver {
    IPoolAddressesProvider public immutable override ADDRESSES_PROVIDER;
    IPool public immutable override POOL;

    event Operation(address asset, uint256 amount, uint256 premium, address initiator);

    constructor(IPoolAddressesProvider provider) {
        ADDRESSES_PROVIDER = provider;
        POOL = IPool(provider.getPool());
    }

    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata
    ) external override returns (bool) {
        emit Operation(asset, amount, premium, initiator);
        IERC20Minimal(asset).approve(address(POOL), amount + premium);
        return true;
    }
}

interface IERC20Minimal {
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}
