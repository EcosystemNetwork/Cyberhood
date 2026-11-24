// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Bloom} from "./Bloom.sol";

/// @title The Orchard
/// @notice Stake a Uniswap V2 pool's LP tokens in one of the Orchard's groves and Bloom grows for
///         you every second, split between the groves by their `alloc` weight.
///
///         Emission: `initialRate` Bloom a second from `start`, halving every `halving` seconds,
///         so at most 2 * initialRate * halving is ever minted (checked against Bloom's cap).
///
///         Harvest: `unlockedBps` of what you harvest is paid straight away; the rest is locked and
///         unlocks linearly. Locking more merges it into your schedule: what is still locked plus
///         the new amount then unlock together, ending at the amount-weighted average of the two
///         end times. `claimVested` pays out what has unlocked so far.
///
/// @dev Non-custodial: no role can move staked LP tokens; `emergencyWithdraw` always works and
///      gives up only the unharvested Bloom. The admin (a multisig on mainnet) can only add groves
///      and change their weights. Bloom is minted on payout, never held here.
contract Orchard is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 private constant ACC = 1e18; // fixed-point scale of `acc`
    uint256 private constant BPS = 10_000;
    uint256 public constant MAX_GROVES = 32; // bounds every loop over the groves
    uint256 private constant MAX_EPOCHS = 64; // the rate is 0 after 64 halvings anyway

    struct Grove {
        IERC20 lp;
        uint256 alloc; // share of the emission
        uint256 staked; // LP tokens held for stakers
        uint256 acc; // Bloom per staked LP token so far, times ACC
        uint256 last; // when `acc` was last brought up to date
    }

    struct Stake {
        uint256 amount;
        uint256 debt; // amount * acc / ACC at the last settle
    }

    struct Vest {
        uint256 locked; // still locked, unlocking linearly from `start` to `end`
        uint64 start;
        uint64 end;
    }

    Bloom public immutable bloom;
    uint256 public immutable start;
    uint256 public immutable initialRate; // Bloom (wei) a second in the first epoch
    uint256 public immutable halving; // epoch length in seconds
    uint256 public immutable unlockedBps; // part of a harvest paid at once
    uint256 public immutable vestDuration; // how long the locked part takes to unlock

    Grove[] public groves;
    uint256 public totalAlloc;
    mapping(address => bool) public listed;
    mapping(uint256 => mapping(address => Stake)) public stakes;
    mapping(address => Vest) public vests;

    event GroveAdded(uint256 indexed gid, address indexed lp, uint256 alloc);
    event GroveSet(uint256 indexed gid, uint256 alloc);
    event Deposit(address indexed who, uint256 indexed gid, uint256 amount);
    event Withdraw(address indexed who, uint256 indexed gid, uint256 amount);
    event EmergencyWithdraw(address indexed who, uint256 indexed gid, uint256 amount);
    event Harvest(address indexed who, uint256 indexed gid, uint256 paid, uint256 locked);
    event Vested(address indexed who, uint256 amount);

    error BadConfig();
    error AlreadyListed();
    error TooManyGroves();
    error NoGrove();
    error Insufficient();

    constructor(
        address admin,
        Bloom bloom_,
        uint256 start_,
        uint256 initialRate_,
        uint256 halving_,
        uint256 unlockedBps_,
        uint256 vestDuration_
    ) {
        if (halving_ == 0 || unlockedBps_ > BPS || (unlockedBps_ < BPS && vestDuration_ == 0)) revert BadConfig();
        if (2 * initialRate_ * halving_ > bloom_.cap() - bloom_.totalSupply()) revert BadConfig();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        bloom = bloom_;
        start = start_;
        initialRate = initialRate_;
        halving = halving_;
        unlockedBps = unlockedBps_;
        vestDuration = vestDuration_;
    }

    // ---------------------------------------------------------------- admin

    function addGrove(IERC20 lp, uint256 alloc) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (listed[address(lp)]) revert AlreadyListed();
        if (groves.length >= MAX_GROVES) revert TooManyGroves();
        _updateAll();
        listed[address(lp)] = true;
        totalAlloc += alloc;
        groves.push(Grove({lp: lp, alloc: alloc, staked: 0, acc: 0, last: block.timestamp > start ? block.timestamp : start}));
        emit GroveAdded(groves.length - 1, address(lp), alloc);
    }

    function setGrove(uint256 gid, uint256 alloc) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (gid >= groves.length) revert NoGrove();
        _updateAll();
        totalAlloc = totalAlloc - groves[gid].alloc + alloc;
        groves[gid].alloc = alloc;
        emit GroveSet(gid, alloc);
    }

    // ---------------------------------------------------------------- players

    function deposit(uint256 gid, uint256 amount) external nonReentrant {
        Grove storage g = _update(gid);
        Stake storage s = stakes[gid][msg.sender];
        _settle(gid, g, s);
        if (amount > 0) {
            uint256 before = g.lp.balanceOf(address(this));
            g.lp.safeTransferFrom(msg.sender, address(this), amount);
            uint256 got = g.lp.balanceOf(address(this)) - before;
            s.amount += got;
            g.staked += got;
            emit Deposit(msg.sender, gid, got);
        }
        s.debt = (s.amount * g.acc) / ACC;
    }

    function withdraw(uint256 gid, uint256 amount) external nonReentrant {
        Grove storage g = _update(gid);
        Stake storage s = stakes[gid][msg.sender];
        if (amount > s.amount) revert Insufficient();
        _settle(gid, g, s);
        s.amount -= amount;
        g.staked -= amount;
        s.debt = (s.amount * g.acc) / ACC;
        if (amount > 0) {
            g.lp.safeTransfer(msg.sender, amount);
            emit Withdraw(msg.sender, gid, amount);
        }
    }

    /// Harvests every grove you have a stake in, and pays out whatever has unlocked.
    function harvestAll() external nonReentrant {
        for (uint256 gid = 0; gid < groves.length; gid++) {
            Stake storage s = stakes[gid][msg.sender];
            if (s.amount == 0) continue;
            Grove storage g = _update(gid);
            _settle(gid, g, s);
            s.debt = (s.amount * g.acc) / ACC;
        }
        _release(msg.sender);
    }

    function claimVested() external nonReentrant {
        _release(msg.sender);
    }

    /// Takes your LP tokens back without harvesting: the unharvested Bloom is given up.
    function emergencyWithdraw(uint256 gid) external nonReentrant {
        Grove storage g = _update(gid);
        Stake storage s = stakes[gid][msg.sender];
        uint256 amount = s.amount;
        s.amount = 0;
        s.debt = 0;
        g.staked -= amount;
        g.lp.safeTransfer(msg.sender, amount);
        emit EmergencyWithdraw(msg.sender, gid, amount);
    }

    // ---------------------------------------------------------------- views

    function groveCount() external view returns (uint256) {
        return groves.length;
    }

    /// Bloom emitted to all groves together between two times.
    function emitted(uint256 from, uint256 to) public view returns (uint256 sum) {
        if (from < start) from = start;
        if (to <= from) return 0;
        uint256 i = (from - start) / halving;
        while (from < to && i < MAX_EPOCHS) {
            uint256 epochEnd = start + (i + 1) * halving;
            uint256 upto = to < epochEnd ? to : epochEnd;
            sum += (upto - from) * (initialRate >> i);
            from = upto;
            i++;
        }
    }

    /// Bloom a second right now, for all groves together.
    function rate() external view returns (uint256) {
        if (block.timestamp < start) return 0;
        uint256 i = (block.timestamp - start) / halving;
        return i >= MAX_EPOCHS ? 0 : initialRate >> i;
    }

    /// What `who` would harvest from grove `gid` now (before the unlocked / locked split).
    function pending(uint256 gid, address who) external view returns (uint256) {
        if (gid >= groves.length) revert NoGrove();
        Grove storage g = groves[gid];
        uint256 acc = g.acc;
        if (block.timestamp > g.last && g.staked > 0 && totalAlloc > 0) {
            acc += ((emitted(g.last, block.timestamp) * g.alloc) / totalAlloc) * ACC / g.staked;
        }
        Stake storage s = stakes[gid][who];
        return (s.amount * acc) / ACC - s.debt;
    }

    /// `who`'s locked Bloom: what is still locked, what has unlocked and can be claimed, and when the rest is free.
    function vestOf(address who) external view returns (uint256 locked, uint256 ready, uint256 end) {
        Vest memory v = vests[who];
        ready = _vested(v);
        return (v.locked - ready, ready, v.end);
    }

    // ---------------------------------------------------------------- internals

    function _update(uint256 gid) internal returns (Grove storage g) {
        if (gid >= groves.length) revert NoGrove();
        g = groves[gid];
        if (block.timestamp <= g.last) return g;
        if (g.staked > 0 && g.alloc > 0) {
            g.acc += ((emitted(g.last, block.timestamp) * g.alloc) / totalAlloc) * ACC / g.staked;
        }
        g.last = block.timestamp;
    }

    function _updateAll() internal {
        for (uint256 gid = 0; gid < groves.length; gid++) _update(gid);
    }

    // Pays what `s` has earned since its last settle (the caller resets s.debt afterwards).
    function _settle(uint256 gid, Grove storage g, Stake storage s) internal {
        uint256 due = (s.amount * g.acc) / ACC - s.debt;
        if (due == 0) return;
        uint256 now_ = (due * unlockedBps) / BPS;
        uint256 later = due - now_;
        if (now_ > 0) bloom.mint(msg.sender, now_);
        if (later > 0) _lock(msg.sender, later);
        emit Harvest(msg.sender, gid, now_, later);
    }

    function _vested(Vest memory v) internal view returns (uint256) {
        if (v.locked == 0) return 0;
        if (block.timestamp >= v.end || v.end <= v.start) return v.locked;
        if (block.timestamp <= v.start) return 0;
        return (v.locked * (block.timestamp - v.start)) / (v.end - v.start);
    }

    function _lock(address who, uint256 amount) internal {
        _release(who);
        Vest storage v = vests[who];
        uint256 newEnd = block.timestamp + vestDuration;
        if (v.locked > 0) newEnd = (v.locked * v.end + amount * newEnd) / (v.locked + amount);
        v.locked += amount;
        v.start = uint64(block.timestamp);
        v.end = uint64(newEnd);
    }

    function _release(address who) internal {
        Vest storage v = vests[who];
        uint256 ready = _vested(v);
        if (ready == 0) return;
        v.locked -= ready;
        v.start = uint64(block.timestamp);
        bloom.mint(who, ready);
        emit Vested(who, ready);
    }
}
