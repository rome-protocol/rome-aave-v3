// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IERC20} from 'openzeppelin-contracts/contracts/token/ERC20/IERC20.sol';

/**
 * Minimal ERC20 with an external `mint(address,uint256)` callable by the
 * configured `minter`. Used by the Aave-on-Rome demo's /faucet page so
 * test users can claim balance for testing supply / borrow flows without
 * bridging from Solana.
 *
 * Intentionally NOT cached-SPL-wrapper-backed. The 3 canonical reserves
 * (USDC / ETH / SOL on Hadrian) keep their cached-wrapper identity; the
 * 4 mock reserves are pure EVM tokens whose only purpose is testing.
 *
 * Plain ERC20 means Aave's `init-reserve` ATA-warmup probe (selector
 * 0x5e094743) returns false and skips the warmup — these tokens compose
 * with Pool as standard ERC20s.
 */
contract MockToken is IERC20 {
  string public name;
  string public symbol;
  uint8 public decimals;
  uint256 public totalSupply;
  address public minter;

  mapping(address => uint256) public balanceOf;
  mapping(address => mapping(address => uint256)) public allowance;

  constructor(string memory _name, string memory _symbol, uint8 _decimals, address _minter) {
    name = _name;
    symbol = _symbol;
    decimals = _decimals;
    minter = _minter;
  }

  function mint(address to, uint256 amount) external {
    require(msg.sender == minter, "MockToken: not minter");
    totalSupply += amount;
    balanceOf[to] += amount;
    emit Transfer(address(0), to, amount);
  }

  function transfer(address to, uint256 amount) external returns (bool) {
    _transfer(msg.sender, to, amount);
    return true;
  }

  function transferFrom(address from, address to, uint256 amount) external returns (bool) {
    uint256 a = allowance[from][msg.sender];
    require(a >= amount, "MockToken: allowance");
    if (a != type(uint256).max) {
      allowance[from][msg.sender] = a - amount;
    }
    _transfer(from, to, amount);
    return true;
  }

  function approve(address spender, uint256 amount) external returns (bool) {
    allowance[msg.sender][spender] = amount;
    emit Approval(msg.sender, spender, amount);
    return true;
  }

  function _transfer(address from, address to, uint256 amount) internal {
    require(balanceOf[from] >= amount, "MockToken: balance");
    balanceOf[from] -= amount;
    balanceOf[to] += amount;
    emit Transfer(from, to, amount);
  }
}
