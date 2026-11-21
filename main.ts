// Sokoban solver for make.fun's sokoban-solver-01-run-20261121.
//
// The levels are a hallway with independent rooms off it, so the level is
// split into rooms and each room is solved push-optimally on its own; the
// room optima add up to the level's optimum, which is what the checker pays
// full points for. Each room is solved with A* over pushes (a state is the
// boxes plus the player's reachable region, named by its lowest square),
// guided by a minimum-matching heuristic over pull-back push distances,
// and pruned by dead squares, frozen 2x2 blocks and frozen boxes. A
// breadth-first search over pushes with the same pruning backs it up when
// A* spends its work budget. Moves are rebuilt by walking the player to
// each push. Pure: no clock, no randomness, no network, no environment
// variation, so two runs write the same bytes.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// [dx, dy, step letter, push letter]
const DIRS = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
];

// Work budgets, never the clock: a search that spends its budget gives up
// and its caller falls back to the other search.
const ASTAR_EXPANSIONS = 250_000;
const BFS_STATES = 500_000;

/** A level in XSB text: width, height, walls, goals, boxes, player. */
function parseLevel(text) {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const size = w * h;
  const wall = new Uint8Array(size).fill(1);
  const goals = [];
  const boxes = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  // A square on the outermost frame is a wall whatever it shows.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  boxes.sort((a, b) => a - b);
  goals.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

// Minimum pushes for a box on `cell` to reach `goal`, ignoring other
// boxes: pull back from the goal; a box on y can be pushed to x (one push)
// when the player can stand behind it, on y - d. -1 when no push path
// exists, which also marks the dead squares (corners included).
function pushDistances(w, h, wall, goal) {
  const size = w * h;
  const dist = new Int32Array(size).fill(-1);
  const queue = [goal];
  dist[goal] = 0;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi];
    for (let k = 0; k < 4; k++) {
      const d = DIRS[k][1] * w + DIRS[k][0];
      const y = x - d;
      const behind = y - d;
      if (y < 0 || y >= size || behind < 0 || behind >= size) continue;
      if (wall[y] || wall[behind] || dist[y] >= 0) continue;
      dist[y] = dist[x] + 1;
      queue.push(y);
    }
  }
  return dist;
}

// The squares the player reaches from `from` around walls and the boxes in
// `occupied`, marking them in `seen` with `stamp`; returns the lowest
// square of the region. The region is fixed by the boxes, so two states
// with the same boxes and the same lowest square have the same region.
function regionLow(w, h, wall, occupied, from, seen, stamp, stack) {
  const size = w * h;
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n];
    if (p < low) low = p;
    for (let k = 0; k < 4; k++) {
      const d = DIRS[k][1] * w + DIRS[k][0];
      const q = p + d;
      if (q < 0 || q >= size) continue;
      if (wall[q] || occupied[q] || seen[q] === stamp) continue;
      seen[q] = stamp;
      stack[n++] = q;
    }
  }
  return low;
}

// The level's rooms: cut the dead squares of the player's row (the
// hallway: a box there reaches no goal) out of the floor, and each part
// left that holds a box is a room. Null when the level is no set of rooms
// (a box starts in the hallway, a goal is cut off, or a part holds a
// different count of boxes and goals).
function roomsOf(level) {
  const { w, h, wall, goals, boxes, player } = level;
  const size = w * h;
  const dists = goals.map((g) => pushDistances(w, h, wall, g));
  const live = new Uint8Array(size);
  for (const dist of dists) {
    for (let c = 0; c < size; c++) if (dist[c] >= 0) live[c] = 1;
  }
  const row = Math.floor(player / w);
  const cut = new Uint8Array(size);
  for (let i = row * w; i < (row + 1) * w; i++) {
    if (!wall[i] && !live[i]) cut[i] = 1;
  }
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(size).fill(-1);
  const rooms = [];
  for (let s = 0; s < size; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (let k = 0; k < 4; k++) {
        const d = DIRS[k][1] * w + DIRS[k][0];
        const q = squares[i] + d;
        if (q < 0 || q >= size) continue;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [], done: false });
  }
  for (const b of boxes) rooms[part[b]].boxes.push(b);
  for (const g of goals) {
    if (part[g] < 0) return null;
    rooms[part[g]].goals.push(g);
  }
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

// Whether the box just pushed to `t` sits in a frozen 2x2 block of walls
// and boxes with a box off its goal: no box in such a block ever moves.
function frozenBlock(w, h, wall, occupied, goal, t) {
  const size = w * h;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (a < 0 || d >= size) continue;
    if (!(wall[a] || occupied[a])) continue;
    if (!(wall[b] || occupied[b])) continue;
    if (!(wall[c] || occupied[c])) continue;
    if (!(wall[d] || occupied[d])) continue;
    if (
      (occupied[a] && !goal[a]) ||
      (occupied[b] && !goal[b]) ||
      (occupied[c] && !goal[c]) ||
      (occupied[d] && !goal[d])
    ) {
      return true;
    }
  }
  return false;
}

// Whether some box off its goal can never move again: every direction is
// blocked by a wall, by the board's edge, or by a box that itself can
// never move (least fixed point, starting from the wall-blocked boxes).
function anyFrozen(boxes, w, h, wall, goal) {
  const size = w * h;
  const n = boxes.length;
  const frozen = new Uint8Array(n);
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < n; i++) {
      if (frozen[i] || goal[boxes[i]]) continue;
      const b = boxes[i];
      let stuck = true;
      for (let k = 0; k < 4; k++) {
        const d = DIRS[k][1] * w + DIRS[k][0];
        const t = b + d;
        const behind = b - d;
        if (t < 0 || t >= size || behind < 0 || behind >= size) continue;
        if (wall[t] || wall[behind]) continue;
        let j = -1;
        for (let m = 0; m < n; m++) {
          if (boxes[m] === t) {
            j = m;
            break;
          }
        }
        if (j < 0 || !frozen[j]) {
          stuck = false;
          break;
        }
      }
      if (stuck) {
        frozen[i] = 1;
        changed = true;
      }
    }
  }
  for (let i = 0; i < n; i++) {
    if (frozen[i] && !goal[boxes[i]]) return true;
  }
  return false;
}

// The shortest walk from `from` to `to` around walls and boxes, in lower
// LURD letters (the first direction first on ties). Throws when the target
// is out of reach, which a valid push sequence never asks for.
function walkTo(w, h, wall, occupied, from, to) {
  const size = w * h;
  if (from === to) return '';
  const prev = new Int32Array(size).fill(-1);
  const how = new Array(size);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
    if (p === to) break;
    for (let k = 0; k < 4; k++) {
      const d = DIRS[k][1] * w + DIRS[k][0];
      const q = p + d;
      if (q < 0 || q >= size) continue;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = DIRS[k][2];
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: the push square is out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]) s = how[p] + s;
  return s;
}

// Minimum total pushes to put every box on a distinct goal, each box
// costed by its pull-back distance ignoring the other boxes. One push
// moves one box one square, so the matching cost can fall by at most one
// per push: the heuristic is admissible and consistent, and A* with it
// stays push-optimal. Infinity when a box reaches no goal.
function matchingCost(boxes, dists) {
  const n = boxes.length;
  let best = Infinity;
  const used = new Uint8Array(n);
  const rec = (i, sum) => {
    if (sum >= best) return;
    if (i === n) {
      best = sum;
      return;
    }
    for (let g = 0; g < n; g++) {
      if (used[g]) continue;
      const d = dists[g][boxes[i]];
      if (d < 0) continue;
      used[g] = 1;
      rec(i + 1, sum + d);
      used[g] = 0;
    }
  };
  rec(0, 0);
  return best;
}

// The push-optimal solution of `sub` (a room, or the whole level as a
// fallback): {pushes, moves, endPlayer}, or null when the search gives up
// (or the level has no solution). `astar` picks A* with the matching
// heuristic, else breadth-first over pushes; both are push-optimal, both
// prune dead squares, frozen 2x2 blocks and frozen boxes, and both key a
// state by its boxes and its region's lowest square.
function searchPushOptimal(sub, maxStates, astar) {
  const { w, h, wall, goals, boxes: startBoxes, player: startPlayer } = sub;
  const size = w * h;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const dists = goals.map((g) => pushDistances(w, h, wall, g));
  const live = new Uint8Array(size);
  for (const dist of dists) {
    for (let c = 0; c < size; c++) if (dist[c] >= 0) live[c] = 1;
  }
  const solved = (bs) => {
    for (const b of bs) if (!goal[b]) return false;
    return true;
  };
  if (startBoxes.some((b) => !live[b])) return null;
  if (solved(startBoxes)) return { pushes: 0, moves: '', endPlayer: startPlayer };

  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  const keyOf = (bs, low) => {
    let k = low;
    for (const b of bs) k = k * size + b;
    return k;
  };

  // The states in the order found: their boxes, the player's square, the
  // region's lowest square, pushes so far, parent and the push direction.
  const sBoxes = [startBoxes.slice()];
  const sPlayer = [startPlayer];
  const sLow = [0];
  const sG = [0];
  const parent = [-1];
  const pdir = [-1];
  const best = new Map();
  for (const b of startBoxes) occupied[b] = 1;
  sLow[0] = regionLow(w, h, wall, occupied, startPlayer, seen, ++stamp, stack);
  for (const b of startBoxes) occupied[b] = 0;
  best.set(keyOf(startBoxes, sLow[0]), 0);

  // Open list: a heap on (f, h, insertion order) for A*, a FIFO queue else.
  const heap = [];
  const heapLess = (a, b) =>
    a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])));
  const heapPush = (e) => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!heapLess(heap[i], heap[p])) break;
      const tmp = heap[i];
      heap[i] = heap[p];
      heap[p] = tmp;
      i = p;
    }
  };
  const heapPop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && heapLess(heap[c + 1], heap[c])) c++;
        if (!heapLess(heap[c], heap[i])) break;
        const tmp = heap[i];
        heap[i] = heap[c];
        heap[c] = tmp;
        i = c;
      }
    }
    return top;
  };
  const queue = [0];
  let qhead = 0;
  let seq = 0;
  if (astar) {
    const h0 = matchingCost(startBoxes, dists);
    heapPush([h0, h0, seq++, 0]);
  }

  let expanded = 0;
  let found = -1;
  while ((astar ? heap.length > 0 : qhead < queue.length) && found < 0) {
    const s = astar ? heapPop()[3] : queue[qhead++];
    const g = sG[s];
    if (best.get(keyOf(sBoxes[s], sLow[s])) !== g) continue;
    if (expanded >= maxStates) return null;
    expanded++;
    const boxes = sBoxes[s];
    for (const b of boxes) occupied[b] = 1;
    const here = ++stamp;
    regionLow(w, h, wall, occupied, sPlayer[s], seen, here, stack);
    for (let bi = 0; bi < boxes.length && found < 0; bi++) {
      const b = boxes[bi];
      for (let k = 0; k < 4; k++) {
        const d = DIRS[k][1] * w + DIRS[k][0];
        const t = b + d;
        const behind = b - d;
        if (behind < 0 || behind >= size || seen[behind] !== here) continue;
        if (t < 0 || t >= size || wall[t] || occupied[t] || !live[t]) continue;
        const next0 = boxes.slice();
        next0[bi] = t;
        next0.sort((x, y) => x - y);
        occupied[b] = 0;
        occupied[t] = 1;
        const frozen =
          frozenBlock(w, h, wall, occupied, goal, t) ||
          anyFrozen(next0, w, h, wall, goal);
        let key = -1;
        let next = null;
        let low = -1;
        if (!frozen) {
          next = next0;
          low = regionLow(w, h, wall, occupied, b, mark, ++stamp, stack);
          key = keyOf(next, low);
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (frozen) continue;
        const prevG = best.get(key);
        if (prevG !== undefined && prevG <= g + 1) continue;
        if (sBoxes.length >= maxStates) {
          for (const x of boxes) occupied[x] = 0;
          return null;
        }
        best.set(key, g + 1);
        const idx = sBoxes.length;
        sBoxes.push(next);
        sPlayer.push(b);
        sLow.push(low);
        sG.push(g + 1);
        parent.push(s);
        pdir.push(k);
        if (solved(next)) {
          found = idx;
          break;
        }
        if (astar) {
          const hh = matchingCost(next, dists);
          heapPush([g + 1 + hh, hh, seq++, idx]);
        } else {
          queue.push(idx);
        }
      }
    }
    for (const b of boxes) occupied[b] = 0;
  }
  if (found < 0) return null;

  // The path of states, then the moves: walk to each push's square, push.
  const path = [];
  for (let s = found; s > 0; s = parent[s]) path.push(s);
  path.reverse();
  let moves = '';
  let player = startPlayer;
  let boxes = startBoxes.slice();
  for (const s of path) {
    const nextBoxes = sBoxes[s];
    const from = boxes.find((b) => !nextBoxes.includes(b));
    const to = nextBoxes.find((b) => !boxes.includes(b));
    const k = pdir[s];
    const d = DIRS[k][1] * w + DIRS[k][0];
    for (const b of boxes) occupied[b] = 1;
    moves += walkTo(w, h, wall, occupied, player, from - d);
    for (const b of boxes) occupied[b] = 0;
    moves += DIRS[k][3];
    player = from;
    boxes = nextBoxes;
  }
  return { pushes: path.length, moves, endPlayer: player };
}

// One room's push-optimal solution: the other rooms' boxes stand as walls
// (their goals once their room is done, since the boxes sit there then),
// the player walking on from where the last room left it. A* first,
// breadth-first over pushes when A* spends its budget.
function solveRoom(level, rooms, ri, player) {
  const room = rooms[ri];
  const wall = level.wall.slice();
  for (let j = 0; j < rooms.length; j++) {
    if (j === ri) continue;
    const other = rooms[j];
    const cells = other.done ? other.goals : other.boxes;
    for (const c of cells) wall[c] = 1;
  }
  const sub = {
    w: level.w,
    h: level.h,
    wall,
    goals: room.goals.slice(),
    boxes: room.boxes.slice(),
    player,
  };
  let r = searchPushOptimal(sub, ASTAR_EXPANSIONS, true);
  if (r === null) r = searchPushOptimal(sub, BFS_STATES, false);
  return r;
}

// The level solved room by room: each room's push-optimal solution in
// turn, the player walking on from where the last room left it. A box
// never leaves its room, so the rooms' optima add up to the level's.
// Null (an empty answer) when a room's search gives up, or the level is
// no set of rooms and the whole-level search gives up too.
function solveLevel(text) {
  const level = parseLevel(text);
  if (level.boxes.every((b) => level.goals.includes(b))) return '';
  const rooms = roomsOf(level);
  if (rooms === null) {
    const whole =
      searchPushOptimal(level, ASTAR_EXPANSIONS, true) ??
      searchPushOptimal(level, BFS_STATES, false);
    return whole === null ? '' : whole.moves;
  }
  let player = level.player;
  let moves = '';
  for (let i = 0; i < rooms.length; i++) {
    const r = solveRoom(level, rooms, i, player);
    if (r === null) return '';
    moves += r.moves;
    player = r.endPlayer;
    rooms[i].done = true;
  }
  return moves;
}

for (const id of readdirSync(I).sort()) {
  let moves = '';
  try {
    moves = solveLevel(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  } catch (err) {
    console.error(`${id}: ${err instanceof Error ? err.message : String(err)}`);
    moves = '';
  }
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
