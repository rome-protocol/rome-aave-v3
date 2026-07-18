// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {MockToken} from "./MockToken.sol";

/**
 * One-shot test-asset faucet for the Aave-on-Rome demo's /faucet page.
 *
 * On `claim()`:
 *   1. Sends `gasDrop` native gas to msg.sender (one-time per user)
 *   2. Mints `tokenDrop[token]` of each whitelisted MockToken to msg.sender
 *
 * Each address can claim AT MOST ONCE. Gas and tokens drop together so a
 * fresh wallet receives everything it needs to test supply/borrow flows in
 * one click.
 *
 * Deployer is the owner of every MockToken and the faucet. Deployer
 * pre-funds the faucet with native gas at construction.
 */
contract Faucet {
  address public immutable owner;
  uint256 public immutable gasDrop;
  MockToken[] public tokens;
  mapping(address => uint256) public tokenDrop;          // raw token units
  mapping(address => bool)    public claimed;

  event Claimed(address indexed user, uint256 gasAmount, uint256 tokenCount);
  event TokenAdded(address indexed token, uint256 amount);

  modifier onlyOwner() {
    require(msg.sender == owner, "Faucet: not owner");
    _;
  }

  constructor(uint256 _gasDrop) payable {
    owner = msg.sender;
    gasDrop = _gasDrop;
  }

  /// @notice Accept native gas top-ups any time.
  receive() external payable {}

  /// @notice Register a MockToken with this faucet. `amount` is the raw
  /// token-unit drop per claim (multiplied by `10**decimals` off-chain).
  function addToken(MockToken token, uint256 amount) external onlyOwner {
    tokens.push(token);
    tokenDrop[address(token)] = amount;
    emit TokenAdded(address(token), amount);
  }

  /// @notice One-time drop: gasDrop native + tokenDrop[t] for each registered token.
  function claim() external {
    require(!claimed[msg.sender], "Faucet: already claimed");
    claimed[msg.sender] = true;

    // Native gas first — preflight failure here aborts the whole drop.
    if (gasDrop > 0) {
      require(address(this).balance >= gasDrop, "Faucet: out of gas reserve");
      (bool ok, ) = msg.sender.call{value: gasDrop}("");
      require(ok, "Faucet: gas send failed");
    }

    // Mint each whitelisted token to the user.
    uint256 n = tokens.length;
    for (uint256 i = 0; i < n; i++) {
      MockToken t = tokens[i];
      t.mint(msg.sender, tokenDrop[address(t)]);
    }

    emit Claimed(msg.sender, gasDrop, n);
  }

  function tokenList() external view returns (MockToken[] memory) {
    return tokens;
  }
}
