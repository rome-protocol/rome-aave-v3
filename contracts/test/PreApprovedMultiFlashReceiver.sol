// SPDX-License-Identifier: MIT
pragma solidity ^0.8.10;

import {PreApprovedFlashReceiverBase} from "./PreApprovedFlashReceiverBase.sol";
import {IPoolAddressesProvider} from "../interfaces/IPoolAddressesProvider.sol";

/// @notice Concrete pre-approved multi-asset flash loan receiver.
/// @dev No-op body — emits an event for traceability and returns true. Used by
/// the rome-aave-v3-demo to showcase multi-asset Pool.flashLoan on Rome and
/// by `gamut-extras` Phase A as a passing smoke. Apps that want to do real
/// work (arb, refinance, swap) should write their own inheriting contract
/// with logic in `_executeOperation`.
///
/// Premium funding: the caller must transfer `premium[i]` of `assets[i]` to
/// this receiver BEFORE invoking Pool.flashLoan, since the no-op body doesn't
/// generate any value. Pool's pull-back at the end of the tx then takes
/// `amounts[i] + premiums[i]` and the receiver ends at zero balance.
contract PreApprovedMultiFlashReceiver is PreApprovedFlashReceiverBase {
    event Operation(address[] assets, uint256[] amounts, uint256[] premiums, address initiator);

    constructor(IPoolAddressesProvider provider) PreApprovedFlashReceiverBase(provider) {}

    function _executeOperation(
        address[] calldata assets,
        uint256[] calldata amounts,
        uint256[] calldata premiums,
        address initiator,
        bytes calldata
    ) internal override returns (bool) {
        emit Operation(assets, amounts, premiums, initiator);
        return true;
    }
}
