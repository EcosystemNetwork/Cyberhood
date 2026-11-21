// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title Taproot Farm Plots
/// @notice The game world's farm plots as land NFTs. Token id = the game's plot number, so a
///         plot can exist at most once on-chain.
/// @dev Minted/burned only by the GameBridge (BRIDGE_ROLE).
contract FarmPlots is ERC721, AccessControl {
    bytes32 public constant BRIDGE_ROLE = keccak256("BRIDGE_ROLE");
    string private baseURI_;

    constructor(address admin, string memory base) ERC721("Taproot Farm Plot", "TPLOT") {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        baseURI_ = base;
    }

    function setBaseURI(string calldata base) external onlyRole(DEFAULT_ADMIN_ROLE) {
        baseURI_ = base;
    }

    function _baseURI() internal view override returns (string memory) {
        return baseURI_;
    }

    function mint(address to, uint256 plot) external onlyRole(BRIDGE_ROLE) {
        _mint(to, plot);
    }

    /// @dev The bridge checks that `from` owns the plot before burning.
    function burn(uint256 plot) external onlyRole(BRIDGE_ROLE) {
        _burn(plot);
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC721, AccessControl) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}
