// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title A Taproot resource (Slime Gel, Copper Ore, Wheat, ...)
/// @notice One ERC-20 per game resource, so each trades and pools like any token. 1 token =
///         1 of the resource in the game (no decimals).
/// @dev Deployed only by the GameBridge (addResource), at a CREATE2 address salted with the
///      resource's id (keccak256 of its game id), and minted/burned only by that bridge.
contract GameResource is ERC20 {
    address public immutable bridge;

    error OnlyBridge();

    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {
        bridge = msg.sender;
    }

    modifier onlyBridge() {
        if (msg.sender != bridge) revert OnlyBridge();
        _;
    }

    function decimals() public pure override returns (uint8) {
        return 0;
    }

    function mint(address to, uint256 amount) external onlyBridge {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external onlyBridge {
        _burn(from, amount);
    }
}
