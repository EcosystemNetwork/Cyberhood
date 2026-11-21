// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title Taproot Gold
/// @notice In-game gold, once a player withdraws it from the game. 1 token = 1 gold (no
///         decimals), so amounts read the same in a wallet as in the game.
/// @dev Only the GameBridge (BRIDGE_ROLE) mints, on a server-signed claim, and burns, when a
///      player deposits gold back into the game. Supply = gold that is currently on-chain.
contract GameGold is ERC20, AccessControl {
    bytes32 public constant BRIDGE_ROLE = keccak256("BRIDGE_ROLE");

    constructor(address admin) ERC20("Taproot Gold", "TGOLD") {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    function decimals() public pure override returns (uint8) {
        return 0;
    }

    function mint(address to, uint256 amount) external onlyRole(BRIDGE_ROLE) {
        _mint(to, amount);
    }

    /// @dev The bridge only ever passes its own msg.sender as `from`.
    function burn(address from, uint256 amount) external onlyRole(BRIDGE_ROLE) {
        _burn(from, amount);
    }
}
