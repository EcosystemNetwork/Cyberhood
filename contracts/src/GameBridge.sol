// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {GameGold} from "./GameGold.sol";
import {GameItems} from "./GameItems.sol";
import {FarmPlots} from "./FarmPlots.sol";
import {GameResource} from "./GameResource.sol";

/// @title Taproot Game Bridge
/// @notice Moves game assets between the game server (where gameplay happens) and the chain:
///         gold and each resource as their own ERC-20, gear as ERC-1155, farm plots as ERC-721.
///         Resources are added by the admin (addResource), which deploys their token.
///
///   Withdraw: the server debits the player's in-game balance, then signs an EIP-712 Claim.
///             Anyone may submit it (the player, or a relayer paying gas); the asset is minted
///             to `to`. Each nonce works once, and only until `deadline`; after the deadline
///             the server sees the nonce unused and refunds the player in-game.
///   Deposit:  a player burns an asset here; the Deposited event is picked up by the server's
///             chain sync, which credits the game account linked to `from`.
///
/// @dev Keep the Claim type in sync with game/lib/chain.js (CLAIM_TYPES).
contract GameBridge is EIP712, AccessControl, Pausable {
    bytes32 public constant SIGNER_ROLE = keccak256("SIGNER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    uint8 public constant KIND_GOLD = 0;
    uint8 public constant KIND_ITEM = 1;
    uint8 public constant KIND_PLOT = 2;
    uint8 public constant KIND_RESOURCE = 3;

    bytes32 public constant CLAIM_TYPEHASH =
        keccak256("Claim(address to,uint8 kind,uint256 id,uint256 amount,uint256 nonce,uint256 deadline)");

    struct Claim {
        address to;
        uint8 kind;
        uint256 id;
        uint256 amount;
        uint256 nonce;
        uint256 deadline;
    }

    GameGold public immutable gold;
    GameItems public immutable items;
    FarmPlots public immutable plots;

    mapping(uint256 => bool) public used;
    /// resource id (keccak256 of the game's resource id) => its GameResource token
    mapping(uint256 => GameResource) public resources;

    /// @notice Mint caps. The signer is a hot key on the game server; if it ever leaks, these bound
    ///         what it can mint before the pauser stops the bridge. Each token (each resource, each
    ///         item id; all plots together, and gold) may mint at most its cap per PERIOD. A token
    ///         uses its own cap if set (`tokenCap`), else its kind's (`kindCap`); with neither, it
    ///         can't be claimed at all. Only the admin (a multisig on mainnet) sets caps. The
    ///         window is fixed, starting at its first mint, so at most 2x a cap can land across a
    ///         window's edge. A claim over the cap reverts; its voucher expires and the game
    ///         server refunds it like any other unused claim.
    uint256 public constant PERIOD = 1 days;

    struct Window {
        uint64 start;
        uint192 minted;
    }

    mapping(uint8 => uint256) public kindCap;
    mapping(uint8 => mapping(uint256 => uint256)) public tokenCap;
    mapping(uint8 => mapping(uint256 => Window)) public windows;

    event Claimed(uint256 indexed nonce, address indexed to, uint8 kind, uint256 id, uint256 amount);
    event KindCapSet(uint8 indexed kind, uint256 cap);
    event TokenCapSet(uint8 indexed kind, uint256 indexed id, uint256 cap);
    event Deposited(address indexed from, uint8 kind, uint256 id, uint256 amount);
    event ResourceAdded(uint256 indexed id, address token, string symbol);

    error Expired();
    error NonceUsed();
    error BadSigner();
    error BadKind();
    error BadAmount();
    error NotPlotOwner();
    error UnknownResource();
    error ResourceExists();
    error OverCap();
    error BadCap();

    constructor(address admin, address signer, GameGold gold_, GameItems items_, FarmPlots plots_)
        EIP712("TaprootBridge", "1")
    {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
        _grantRole(SIGNER_ROLE, signer);
        gold = gold_;
        items = items_;
        plots = plots_;
    }

    function hashClaim(Claim calldata c) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(abi.encode(CLAIM_TYPEHASH, c.to, c.kind, c.id, c.amount, c.nonce, c.deadline))
        );
    }

    function claim(Claim calldata c, bytes calldata signature) external whenNotPaused {
        if (block.timestamp > c.deadline) revert Expired();
        if (used[c.nonce]) revert NonceUsed();
        if (!hasRole(SIGNER_ROLE, ECDSA.recover(hashClaim(c), signature))) revert BadSigner();
        used[c.nonce] = true;
        if (c.kind > KIND_RESOURCE) revert BadKind();
        _spendCap(c.kind, c.kind == KIND_PLOT ? 0 : c.id, c.amount);

        if (c.kind == KIND_GOLD) {
            if (c.amount == 0) revert BadAmount();
            gold.mint(c.to, c.amount);
        } else if (c.kind == KIND_ITEM) {
            if (c.amount == 0) revert BadAmount();
            items.mint(c.to, c.id, c.amount);
        } else if (c.kind == KIND_PLOT) {
            if (c.amount != 1) revert BadAmount();
            plots.mint(c.to, c.id);
        } else if (c.kind == KIND_RESOURCE) {
            if (c.amount == 0) revert BadAmount();
            _resource(c.id).mint(c.to, c.amount);
        } else {
            revert BadKind();
        }
        emit Claimed(c.nonce, c.to, c.kind, c.id, c.amount);
    }

    function deposit(uint8 kind, uint256 id, uint256 amount) external whenNotPaused {
        if (kind == KIND_GOLD) {
            if (amount == 0) revert BadAmount();
            gold.burn(msg.sender, amount);
        } else if (kind == KIND_ITEM) {
            if (amount == 0) revert BadAmount();
            items.burn(msg.sender, id, amount);
        } else if (kind == KIND_PLOT) {
            if (amount != 1) revert BadAmount();
            if (plots.ownerOf(id) != msg.sender) revert NotPlotOwner();
            plots.burn(id);
        } else if (kind == KIND_RESOURCE) {
            if (amount == 0) revert BadAmount();
            _resource(id).burn(msg.sender, amount);
        } else {
            revert BadKind();
        }
        emit Deposited(msg.sender, kind, id, amount);
    }

    /// @notice Deploys a resource's ERC-20. `id` = uint256(keccak256(bytes(gameId))), e.g. "slime_gel".
    function addResource(uint256 id, string calldata name, string calldata symbol)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
        returns (address token)
    {
        if (address(resources[id]) != address(0)) revert ResourceExists();
        GameResource r = new GameResource{salt: bytes32(id)}(name, symbol);
        resources[id] = r;
        emit ResourceAdded(id, address(r), symbol);
        return address(r);
    }

    /// @notice The cap that applies to a token: its own if set, else its kind's. Plots share id 0.
    function capOf(uint8 kind, uint256 id) public view returns (uint256) {
        uint256 own = tokenCap[kind][id];
        return own != 0 ? own : kindCap[kind];
    }

    /// @notice What a token can still mint in its current window.
    function mintable(uint8 kind, uint256 id) external view returns (uint256) {
        Window memory w = windows[kind][id];
        uint256 used_ = block.timestamp >= uint256(w.start) + PERIOD ? 0 : w.minted;
        uint256 cap = capOf(kind, id);
        return cap > used_ ? cap - used_ : 0;
    }

    function setKindCap(uint8 kind, uint256 cap) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (kind > KIND_RESOURCE) revert BadKind();
        if (cap > type(uint192).max) revert BadCap();
        kindCap[kind] = cap;
        emit KindCapSet(kind, cap);
    }

    /// @dev cap 0 = back to the kind's cap.
    function setTokenCap(uint8 kind, uint256 id, uint256 cap) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (kind > KIND_RESOURCE) revert BadKind();
        if (cap > type(uint192).max) revert BadCap();
        tokenCap[kind][id] = cap;
        emit TokenCapSet(kind, id, cap);
    }

    function _spendCap(uint8 kind, uint256 id, uint256 amount) private {
        Window storage w = windows[kind][id];
        if (block.timestamp >= uint256(w.start) + PERIOD) {
            w.start = uint64(block.timestamp);
            w.minted = 0;
        }
        if (uint256(w.minted) + amount > capOf(kind, id)) revert OverCap();
        w.minted = uint192(uint256(w.minted) + amount);
    }

    function _resource(uint256 id) private view returns (GameResource r) {
        r = resources[id];
        if (address(r) == address(0)) revert UnknownResource();
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }
}
