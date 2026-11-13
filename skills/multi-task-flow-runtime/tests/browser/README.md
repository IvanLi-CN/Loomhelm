# Browser width regression

The agreed seam is the rendered mock example: click a task to open details and click Close to dismiss them. Compare each task's actual DOM width and each board column's width across closed → open → closed states. At each viewport, also compare board columns with grid cards: their outer widths must match, while board task cards must be 22px narrower to allow for the group container. Backend behavior is outside this test. Happy DOM cannot verify this contract.

Build the existing `demo:static` surface and use its current owned preview server. In the Codex in-app browser REPL, bind the preview tab and viewport capability, import the checked-in runner, then run it:

```js
var regression = await import("file:///absolute/repo/skills/multi-task-flow-runtime/tests/browser/card-width-regression.ts");
await regression.checkCardWidths(tab, viewport);
```

Alternatively paste the exported function without `export`. It throws with per-object measurements on failure, returns measurements on success, and resets the viewport in `finally`. The default matrix covers both board and grid at 1304, 768, 1024, 1120 and 1444px, with 1470px viewport height. Every task and board column is matched by object ID; no expected CSS sizing formula is repeated in the assertions.

The first red run on the board at 1304px measured columns 360 → 290.75 → 360px and task cards 338 → 268.75 → 338px. Fixed container-derived board tracks made that case green. The next slice caught grid cards changing 292.5 → 288.75px at 1304px and 246.5 → 330.328125px at 1120px when the document scrollbar appeared. A stable root scrollbar gutter made both layouts green.

The sizing contract distinguishes the outer track from nested content: board columns match grid task cards, and board task cards are naturally smaller. A red cross-layout test at 1304px found the incorrect 310.75px column next to 288.75px grid cards. Removing the extra 22px from the board track made this test green. Removing the board strip's horizontal padding prevents a spurious scrollbar when two outer tracks exactly fit the task area.

Final real-browser measurements (closed/open/reclosed values are equal; all 10 tasks and both board columns were checked):

| Viewport | Grid task / board column | Nested board task | Maximum width change |
| - | - | - | - |
| 768 | 341.5 | 319.5 | 0 |
| 1024 | 306.328125 | 284.328125 | 0 |
| 1120 | 330.328125 | 308.328125 | 0 |
| 1304 | 288.75 | 266.75 | 0 |
| 1444 | 255 | 233 | 0 |

Inspector limits are fixed at 243px minimum and 740px maximum. These constants were selected from the task-card design range once; runtime limits must not multiply the current card width. The test also rejects layouts where an extra complete task track and its gap could fit while retaining a 243px inspector. The red run at 1304px found a 597.5px inspector and only 597.5px of task space. After reserving the absolute minimum and maximizing whole task tracks, task space is 906.25px (three tracks), and the inspector receives 288.75px of remainder.

| Viewport | Task area with details | Inspector | Complete task tracks |
| - | - | - | - |
| 768 | 341.5 | 341.5 | 1 |
| 1024 | 632.6640625 | 306.3359375 | 2 |
| 1120 | 680.6640625 | 330.3359375 | 2 |
| 1304 | 906.25 | 288.75 | 3 |
| 1444 | 1080 | 255 | 4 |

No case caused horizontal document overflow. Both board columns fit at every measured viewport except 768px, where the board scrolls inside its one available track. Detail widths happen to be close to card widths in this evenly divided layout, but the product limits are absolute rather than one/two current cards. These measurements are acceptance evidence from this candidate, not substitutes for rerunning after UI changes.
