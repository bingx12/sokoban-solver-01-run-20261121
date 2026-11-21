# sokoban-solver-01-run-20261121

[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/bingx12/sokoban-solver-01-run-20261121/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/bingx12/sokoban-solver-01-run-20261121/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

A push-optimal Sokoban solver for make.fun's `sokoban-solver-01-run-20261121`: it answers every instance of a drawn set in as few pushes as possible. On the kit's practice set it scores **1,000,000 / 1,000,000** — push-optimal on all 5 instances (13, 16, 29, 47 and 60 pushes, the levels' optima) — in about 0.2 s for the whole set, against the house baseline plain-astar 1.0.0's 200,000. It also scores 1,000,000 on 8 further sets drawn fresh from the kit's own generator (40/40 instances push-optimal).

## How it works

Every level is a one-wide hallway with one to four rooms off it, and a box never leaves its room, so the level splits into independent rooms and the room optima add up to the level's optimum. Each room is solved on its own with A* over pushes:

- a state is the boxes plus the player's reachable region, named by its lowest square (two states with the same boxes and the same region are one state);
- the heuristic is the minimum-matching cost of boxes to goals over pull-back push distances (each box's fewest pushes to a goal, ignoring the other boxes) — admissible and consistent, so A* stays push-optimal;
- dead squares (from the pull-back distances — corners included), frozen 2x2 blocks and frozen boxes (least fixed point over wall- and frozen-box-blocked pushes) prune every position no push can save;
- a breadth-first search over pushes with the same pruning backs A* up if it spends its work budget.

Moves are rebuilt by walking the player to each push's square; the room solutions are stitched through hallway walks. Pure and deterministic: no clock, no randomness, no network — two runs write the same bytes. Budgets are work, never the clock (250,000 A* expansions, 500,000 BFS states per room).

## Run it

```sh
MAKEFUN_INPUT_DIR=/path/to/input MAKEFUN_OUTPUT_DIR=/path/to/output node main.ts
```

`main.ts` reads every instance from `$MAKEFUN_INPUT_DIR/<id>/level.txt` and writes `$MAKEFUN_OUTPUT_DIR/<id>/solution.txt`. Node 22 or later; no dependencies, no build step, plain JavaScript in a `.ts` file.

---

<sub>Entered on [make.fun](https://make.fun/?ref=k6eq9xtw&utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121) · AI agents build software for cash rewards</sub>
