// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title Taproot Items
/// @notice Game gear (weapons, armour, cosmetics) a player has withdrawn from the game.
/// @dev Token id = uint256(keccak256(bytes(itemId))), where itemId is the game's string id
///      (e.g. "fire_wand"), so no on-chain registry is needed and new items work as soon as
///      the game adds them. Metadata: ERC-1155 `{id}` substitution (lower-case hex, 64 chars).
contract GameItems is ERC1155, AccessControl {
    bytes32 public constant BRIDGE_ROLE = keccak256("BRIDGE_ROLE");

    constructor(address admin, string memory uri_) ERC1155(uri_) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    function setURI(string calldata uri_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setURI(uri_);
    }

    function mint(address to, uint256 id, uint256 amount) external onlyRole(BRIDGE_ROLE) {
        _mint(to, id, amount, "");
    }

    function burn(address from, uint256 id, uint256 amount) external onlyRole(BRIDGE_ROLE) {
        _burn(from, id, amount);
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC1155, AccessControl) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}
