/**
 * Copyright (c) 2019 The xterm.js authors. All rights reserved.
 * @license MIT
 */

import * as puppeteer from 'puppeteer';
import { assert } from 'chai';
import { ITerminalOptions } from 'xterm';

const APP = 'http://127.0.0.1:3000/test';

let browser: puppeteer.Browser;
let page: puppeteer.Page;
const width = 1024;
const height = 768;

// adjust terminal row/col size so we can test
// >80 up to 223 and >255
const fontSize = 6;
const cols = 260;
const rows = 50;

// for some reason shift gets not caught by selection manager on macos
const noShift = process.platform === 'darwin' ? false : true;

/**
 * Helper functions.
 */
async function openTerminal(options: ITerminalOptions = {}): Promise<void> {
  await page.evaluate(`window.term = new Terminal(${JSON.stringify(options)})`);
  await page.evaluate(`window.term.open(document.querySelector('#terminal-container'))`);
  if (options.rendererType === 'dom') {
    await page.waitForSelector('.xterm-rows');
  } else {
    await page.waitForSelector('.xterm-text-layer');
  }
}

async function resetMouseModes(): Promise<void> {
  return await page.evaluate(`
    window.term.write('\x1b[?9l\x1b[?1000l\x1b[?1001l\x1b[?1002l\x1b[?1003l');
    window.term.write('\x1b[?1005l\x1b[?1006l\x1b[?1015l');
  `);
}

async function getReports(encoding: string): Promise<any[]> {
  const reports = await page.evaluate(`window.calls`);
  await page.evaluate(`window.calls = [];`);
  return reports.map((report: number[]) => parseReport(encoding, report));
}

// translate cell positions into pixel offset
// always adds +2 in each direction so we dont end up in the wrong cell
// due to rounding issues
async function cellPos(col: number, row: number): Promise<number[]> {
  const coords = await page.evaluate(`
    (function() {
      const rect = window.term.element.getBoundingClientRect();
      const dim = term._core._renderService.dimensions;
      return {left: rect.left, top: rect.top, bottom: rect.bottom, right: rect.right, width: dim.actualCellWidth, height: dim.actualCellHeight};
    })();
  `);
  return [col * coords.width + coords.left + 2, row * coords.height + coords.top + 2];
}

/**
 * Patched puppeteer functions.
 * This is needed to:
 *  - translate cell positions into pixel positions
 *  - allow modifiers to be set
 *  - fake wheel events
 */
async function mouseMove(col: number, row: number): Promise<void> {
  const [xPixels, yPixels] = await cellPos(col, row);
  return await page.mouse.move(xPixels, yPixels);
}
async function mouseClick(col: number, row: number): Promise<void> {
  const [xPixels, yPixels] = await cellPos(col, row);
  return await page.mouse.click(xPixels, yPixels);
}
async function mouseDown(button: 'left' | 'right' | 'middle' | undefined): Promise<void> {
  return await page.mouse.down({button});
}
async function mouseUp(button: 'left' | 'right' | 'middle' | undefined): Promise<void> {
  return await page.mouse.up({button});
}
async function wheelUp(): Promise<void> {
  const self = (page.mouse as any);
  return await page.evaluate(`
    window.term.element.dispatchEvent(new WheelEvent('wheel', {clientX: ${self._x}, clientY: ${self._y}, deltaX: 0, deltaY: -10, modifiers: ${self._keyboard._modifiers}}));
  `);
}
async function wheelDown(): Promise<void> {
  const self = (page.mouse as any);
  return await page.evaluate(`
    window.term.element.dispatchEvent(new WheelEvent('wheel', {clientX: ${self._x}, clientY: ${self._y}, deltaX: 0, deltaY: 10, modifiers: ${self._keyboard._modifiers}}));
  `);
}

// button definitions
const buttons: {[key: string]: number} = {
  '<none>':  -1,
  left:       0,
  middle:     1,
  right:      2,
  released:   3,
  wheelUp:    4,
  wheelDown:  5,
  wheelLeft:  6,
  wheelRight: 7,
  aux8:       8,
  aux9:       9,
  aux10:      10,
  aux11:      11,
  aux12:      12,
  aux13:      13,
  aux14:      14,
  aux15:      15
};
const reverseButtons: any = {};
for (const el in buttons) {
  reverseButtons[buttons[el]] = el;
}

// extract button data from buttonCode
function evalButtonCode(code: number): any {
  if (code > 255) {
    return {button: 'invalid', action: 'invalid', modifier: {}};
  }
  const modifier = {shift: !!(code & 4), meta: !!(code & 8), control: !!(code & 16)};
  const move = code & 32;
  let button = code & 3;
  if (code & 128) {
    button |= 8;
  }
  if (code & 64) {
    button |= 4
  }
  let actionS = 'press';
  let buttonS = reverseButtons[button];
  if (button === 3) {
    buttonS = '<none>';
    actionS = 'release';
  }
  if (move) {
    actionS = 'move';
  } else if (4 <= button && button <= 7) {
    buttonS = 'wheel';
    actionS = button === 4 ? 'up' : button === 5 ? 'down' : button === 6 ? 'left' : 'right';
  }
  return {button: buttonS, action: actionS, modifier};
}

// parse a single mouse report
function parseReport(encoding: string, msg: number[]): {state: any; row: number; col: number; } | string {
  let sReport: string;
  let buttonCode: number;
  let row: number;
  let col: number;
  // unpack msg
  const report = String.fromCharCode.apply(null, msg);
  // console.log([report]);
  // skip non mouse reports
  if (!report || report[0] !== '\x1b') {
    return report;
  }
  switch (encoding) {
    case 'DEFAULT':
      return {
        state: evalButtonCode(report.charCodeAt(3) - 32),
        col: report.charCodeAt(4) - 32,
        row: report.charCodeAt(5) - 32
      };
    case 'UTF8':
      // TODO: once the binary patch is in place,
      // use UTF8 byte check here
      return {
        state: evalButtonCode(report.charCodeAt(3) - 32),
        col: report.charCodeAt(4) - 32,
        row: report.charCodeAt(5) - 32
      };
    case 'SGR':
      sReport = report.slice(3, -1);
      [buttonCode, col, row] = sReport.split(';').map(el => parseInt(el));
      const state = evalButtonCode(buttonCode);
      if (report[report.length - 1] === 'm') {
        state.action = 'release';
      }
      return {state, row, col};
    case 'URXVT':
      sReport = report.slice(2, -1);
      [buttonCode, col, row] = sReport.split(';').map(el => parseInt(el));
      return {state: evalButtonCode(buttonCode - 32), row: --row, col: --col}; // FIXME: remove -1 here when fixed!
    default:
      return {
        state: evalButtonCode(report.charCodeAt(3) - 32),
        col: report.charCodeAt(4) - 32,
        row: report.charCodeAt(5) - 32
      };
  }
}

/**
 * Mouse tracking tests.
 */
describe('Mouse Tracking Tests', function(): void {
  this.timeout(30000);

  before(async function(): Promise<any> {
    browser = await puppeteer.launch({
      headless: process.argv.indexOf('--headless') !== -1,
      slowMo: 80,
      args: [`--window-size=${width},${height}`]
    });
    page = (await browser.pages())[0];
    await page.setViewport({ width, height });
  });

  after(() => {
    browser.close();
  });

  beforeEach(async () => {
    await page.goto(APP);
    await openTerminal();
    // patch terminal to get the onData calls
    // we encode the msg here to an array of codes to not lose bytes
    // (transmission strips non utf8 bytes)
    // also resize so we can properly test the edge cases
    await page.evaluate(`
      window.calls = [];
      window.term.onData(e => calls.push( Array.from(e).map(el => el.charCodeAt(0)) ));
      window.term.setOption('fontSize', ${fontSize});
      window.term.resize(${cols}, ${rows});
    `);
  });

  describe('DECSET 9 (X10)', async () => {
    /**
     * X10 protocol:
     *  - only press events
     *  - no wheel
     *  - no move
     *  - no modifiers
     */
    it('default encoding', async () => {
      const encoding = 'DEFAULT';
      await resetMouseModes();
      await mouseMove(0, 0);
      await page.evaluate(`window.term.write('\x1b[?9h');`);

      // test at 0,0
      await mouseDown('left');
      assert.deepEqual(await getReports(encoding), [{col: 1, row: 1, state: {action: 'press', button: 'left', modifier: {control: false, shift: false, meta: false}}}]);

      // mouseup should not report
      await mouseUp('left');
      assert.deepEqual(await getReports(encoding), []);

      // mousemove should not report
      await mouseMove(50, 10);
      assert.deepEqual(await getReports(encoding), []);
      await mouseDown('left');
      await mouseUp('left');
      assert.deepEqual(await getReports(encoding), [{col: 51, row: 11, state: {action: 'press', button: 'left', modifier: {control: false, shift: false, meta: false}}}]);

      // test at max rows/cols
      // bug: we are capped at col 95 currently
      // fix: allow values up to 223, any bigger should drop to 0
      await mouseMove(cols - 1, rows - 1);
      await mouseDown('left');
      await mouseUp('left');
      assert.deepEqual(await getReports(encoding), [{col: 95, row: rows, state: {action: 'press', button: 'left', modifier: {control: false, shift: false, meta: false}}}]);

      // button press/move/release tests
      // left button
      await mouseMove(43, 24);
      await getReports(encoding); // clear reports
      await mouseDown('left');
      await mouseMove(44, 24);
      await mouseUp('left');
      assert.deepEqual(await getReports(encoding), [{col: 44, row: 25, state: {action: 'press', button: 'left', modifier: {control: false, shift: false, meta: false}}}]);
      // middle button
      // bug: default action not cancelled (adds data to getReports from clipboard under X11)
      // await mouseMove(43, 24);
      // await getReports(encoding); // clear reports
      // await mouseDown('middle');
      // await mouseMove(44, 24);
      // await mouseUp('middle');
      // assert.deepEqual(await getReports(encoding), [{col: 44, row: 25, state: {action: 'press', button: 'middle', modifier: {control: false, shift: false, meta: false}}}]);
      // right button
      // bug: default action not cancelled (popup shown)
      await mouseMove(43, 24);
      await getReports(encoding); // clear reports
      await mouseDown('right');
      await mouseMove(44, 24);
      await mouseUp('right');
      assert.deepEqual(await getReports(encoding), [{col: 44, row: 25, state: {action: 'press', button: 'right', modifier: {control: false, shift: false, meta: false}}}]);

      // wheel
      await mouseMove(43, 24);
      await getReports(encoding); // clear reports
      await wheelUp();
      assert.deepEqual(await getReports(encoding), []);
      await wheelDown();
      assert.deepEqual(await getReports(encoding), []);

      // modifiers
      // CTRL
      await mouseMove(43, 24);
      await getReports(encoding); // clear reports
      await page.keyboard.down('Control');
      await mouseDown('left');
      await mouseMove(44, 24);
      await mouseUp('left');
      await wheelDown();
      await page.keyboard.up('Control');
      assert.deepEqual(await getReports(encoding), [{col: 44, row: 25, state: {action: 'press', button: 'left', modifier: {control: false, shift: false, meta: false}}}]);


      // ALT
      await mouseMove(43, 24);
      await getReports(encoding); // clear reports
      await page.keyboard.down('Alt');
      await mouseDown('left');
      await mouseMove(44, 24);
      await mouseUp('left');
      await wheelDown();
      await page.keyboard.up('Alt');
      assert.deepEqual(await getReports(encoding), [{col: 44, row: 25, state: {action: 'press', button: 'left', modifier: {control: false, shift: false, meta: false}}}]);

      // SHIFT
      // note: caught by selection manager
      // bug? Why not caught by selection manger on macos?
      // bug: no modifier reported
      await mouseMove(43, 24);
      await getReports(encoding); // clear reports
      await page.keyboard.down('Shift');  // defaults to ShiftLeft
      await mouseDown('left');
      await mouseMove(44, 24);
      await mouseUp('left');
      await wheelDown();
      await page.keyboard.up('Shift');
      if (noShift) {
        assert.deepEqual(await getReports(encoding), []);
      } else {
        assert.deepEqual(await getReports(encoding), [
          {col: 44, row: 25, state: {action: 'press', button: 'left', modifier: {control: false, shift: false, meta: false}}}
        ]);
      }
      /*
      // all modifiers
      // bug: this is totally broken with wrong coords and messed up modifiers
      await mouseMove(43, 24);
      await getReports(encoding); // clear reports
      await page.keyboard.down('Control');
      await page.keyboard.down('Alt');
      await page.keyboard.down('Shift');
      await mouseDown('left');
      await mouseMove(44, 24);
      await mouseUp('left');
      await wheelDown();
      await page.keyboard.up('Control');
      await page.keyboard.up('Alt');
      await page.keyboard.up('Shift');
      assert.deepEqual(await getReports(encoding), [{col: 44, row: 25, state: {action: 'press', button: 'left', modifier: {control: false, shift: false, meta: false}}}]);
      */
    });
    it('UTF8 encoding', async () => {
      const encoding = 'UTF8';
      await resetMouseModes();
      await mouseMove(0, 0);
      await page.evaluate(`window.term.write('\x1b[?9h\x1b[?1005h');`);

      // test at 0,0
      await mouseDown('left');
      assert.deepEqual(await getReports(encoding), [{col: 1, row: 1, state: {action: 'press', button: 'left', modifier: {control: false, shift: false, meta: false}}}]);

      // mouseup should not report
      await mouseUp('left');
      assert.deepEqual(await getReports(encoding), []);

      // mousemove should not report
      await mouseMove(50, 10);
      assert.deepEqual(await getReports(encoding), []);
      await mouseDown('left');
      await mouseUp('left');
      assert.deepEqual(await getReports(encoding), [{col: 51, row: 11, state: {action: 'press', button: 'left', modifier: {control: false, shift: false, meta: false}}}]);

      // test at max rows/cols
      await mouseMove(cols - 1, rows - 1);
      await mouseDown('left');
      await mouseUp('left');
      assert.deepEqual(await getReports(encoding), [{col: cols, row: rows, state: {action: 'press', button: 'left', modifier: {control: false, shift: false, meta: false}}}]);

      // button press/move/release tests
      // left button
      await mouseMove(43, 24);
      await getReports(encoding); // clear reports
      await mouseDown('left');
      await mouseMove(44, 24);
      await mouseUp('left');
      assert.deepEqual(await getReports(encoding), [{col: 44, row: 25, state: {action: 'press', button: 'left', modifier: {control: false, shift: false, meta: false}}}]);
      // middle button
      // bug: default action not cancelled (adds data to getReports from clipboard under X11)
      // await mouseMove(43, 24);
      // await getReports(encoding); // clear reports
      // await mouseDown('middle');
      // await mouseMove(44, 24);
      // await mouseUp('middle');
      // assert.deepEqual(await getReports(encoding), [{col: 44, row: 25, state: {action: 'press', button: 'middle', modifier: {control: false, shift: false, meta: false}}}]);
      // right button
      // bug: default action not cancelled (popup shown)
      await mouseMove(43, 24);
      await getReports(encoding); // clear reports
      await mouseDown('right');
      await mouseMove(44, 24);
      await mouseUp('right');
      assert.deepEqual(await getReports(encoding), [{col: 44, row: 25, state: {action: 'press', button: 'right', modifier: {control: false, shift: false, meta: false}}}]);

      // wheel
      await mouseMove(43, 24);
      await getReports(encoding); // clear reports
      await wheelUp();
      assert.deepEqual(await getReports(encoding), []);
      await wheelDown();
      assert.deepEqual(await getReports(encoding), []);

      // modifiers
      // CTRL
      await mouseMove(43, 24);
      await getReports(encoding); // clear reports
      await page.keyboard.down('Control');
      await mouseDown('left');
      await mouseMove(44, 24);
      await mouseUp('left');
      await wheelDown();
      await page.keyboard.up('Control');
      assert.deepEqual(await getReports(encoding), [{col: 44, row: 25, state: {action: 'press', button: 'left', modifier: {control: false, shift: false, meta: false}}}]);


      // ALT
      await mouseMove(43, 24);
      await getReports(encoding); // clear reports
      await page.keyboard.down('Alt');
      await mouseDown('left');
      await mouseMove(44, 24);
      await mouseUp('left');
      await wheelDown();
      await page.keyboard.up('Alt');
      assert.deepEqual(await getReports(encoding), [{col: 44, row: 25, state: {action: 'press', button: 'left', modifier: {control: false, shift: false, meta: false}}}]);

      // SHIFT
      // note: caught by selection manager
      await mouseMove(43, 24);
      await getReports(encoding); // clear reports
      await page.keyboard.down('Shift');  // defaults to ShiftLeft
      await mouseDown('left');
      await mouseMove(44, 24);
      await mouseUp('left');
      await wheelDown();
      await page.keyboard.up('Shift');
      if (noShift) {
        assert.deepEqual(await getReports(encoding), []);
      } else {
        assert.deepEqual(await getReports(encoding), [
          {col: 44, row: 25, state: {action: 'press', button: 'left', modifier: {control: false, shift: false, meta: false}}}
        ]);
      }
      /*
      // all modifiers
      // bug: this is totally broken with wrong coords and messed up modifiers
      await mouseMove(43, 24);
      await getReports(encoding); // clear reports
      await page.keyboard.down('Control');
      await page.keyboard.down('Alt');
      await page.keyboard.down('Shift');
      await mouseDown('left');
      await mouseMove(44, 24);
      await mouseUp('left');
      await wheelDown();
      await page.keyboard.up('Control');
      await page.keyboard.up('Alt');
      await page.keyboard.up('Shift');
      assert.deepEqual(await getReports(encoding), [{col: 44, row: 25, state: {action: 'press', button: 'left', modifier: {control: false, shift: false, meta: false}}}]);
      */
    });
    it('SGR encoding', async () => {
      const encoding = 'SGR';
      await resetMouseModes();
      await mouseMove(0, 0);
      await page.evaluate(`window.term.write('\x1b[?9h\x1b[?1006h');`);

      // test at 0,0
      await mouseDown('left');
      assert.deepEqual(await getReports(encoding), [{col: 1, row: 1, state: {action: 'press', button: 'left', modifier: {control: false, shift: false, meta: false}}}]);

      // mouseup should not report
      await mouseUp('left');
      assert.deepEqual(await getReports(encoding), []);

      // mousemove should not report
      await mouseMove(50, 10);
      assert.deepEqual(await getReports(encoding), []);
      await mouseDown('left');
      await mouseUp('left');
      assert.deepEqual(await getReports(encoding), [{col: 51, row: 11, state: {action: 'press', button: 'left', modifier: {control: false, shift: false, meta: false}}}]);

      // test at max rows/cols
      await mouseMove(cols - 1, rows - 1);
      await mouseDown('left');
      await mouseUp('left');
      assert.deepEqual(await getReports(encoding), [{col: cols, row: rows, state: {action: 'press', button: 'left', modifier: {control: false, shift: false, meta: false}}}]);

      // button press/move/release tests
      // left button
      await mouseMove(43, 24);
      await getReports(encoding); // clear reports
      await mouseDown('left');
      await mouseMove(44, 24);
      await mouseUp('left');
      assert.deepEqual(await getReports(encoding), [{col: 44, row: 25, state: {action: 'press', button: 'left', modifier: {control: false, shift: false, meta: false}}}]);
      // middle button
      // bug: default action not cancelled (adds data to getReports from clipboard under X11)
      // await mouseMove(43, 24);
      // await getReports(encoding); // clear reports
      // await mouseDown('middle');
      // await mouseMove(44, 24);
      // await mouseUp('middle');
      // assert.deepEqual(await getReports(encoding), [{col: 44, row: 25, state: {action: 'press', button: 'middle', modifier: {control: false, shift: false, meta: false}}}]);
      // right button
      // bug: default action not cancelled (popup shown)
      await mouseMove(43, 24);
      await getReports(encoding); // clear reports
      await mouseDown('right');
      await mouseMove(44, 24);
      await mouseUp('right');
      assert.deepEqual(await getReports(encoding), [{col: 44, row: 25, state: {action: 'press', button: 'right', modifier: {control: false, shift: false, meta: false}}}]);

      // wheel
      await mouseMove(43, 24);
      await getReports(encoding); // clear reports
      await wheelUp();
      assert.deepEqual(await getReports(encoding), []);
      await wheelDown();
      assert.deepEqual(await getReports(encoding), []);

      // modifiers
      // CTRL
      await mouseMove(43, 24);
      await getReports(encoding); // clear reports
      await page.keyboard.down('Control');
      await mouseDown('left');
      await mouseMove(44, 24);
      await mouseUp('left');
      await wheelDown();
      await page.keyboard.up('Control');
      assert.deepEqual(await getReports(encoding), [{col: 44, row: 25, state: {action: 'press', button: 'left', modifier: {control: false, shift: false, meta: false}}}]);


      // ALT
      await mouseMove(43, 24);
      await getReports(encoding); // clear reports
      await page.keyboard.down('Alt');
      await mouseDown('left');
      await mouseMove(44, 24);
      await mouseUp('left');
      await wheelDown();
      await page.keyboard.up('Alt');
      assert.deepEqual(await getReports(encoding), [{col: 44, row: 25, state: {action: 'press', button: 'left', modifier: {control: false, shift: false, meta: false}}}]);

      // SHIFT
      // note: caught by selection manager
      await mouseMove(43, 24);
      await getReports(encoding); // clear reports
      await page.keyboard.down('Shift');  // defaults to ShiftLeft
      await mouseDown('left');
      await mouseMove(44, 24);
      await mouseUp('left');
      await wheelDown();
      await page.keyboard.up('Shift');
      if (noShift) {
        assert.deepEqual(await getReports(encoding), []);
      } else {
        assert.deepEqual(await getReports(encoding), [
          {col: 44, row: 25, state: {action: 'press', button: 'left', modifier: {control: false, shift: false, meta: false}}}
        ]);
      }
      /*
      // all modifiers
      // bug: this is totally broken with wrong coords and messed up modifiers
      await mouseMove(43, 24);
      await getReports(encoding); // clear reports
      await page.keyboard.down('Control');
      await page.keyboard.down('Alt');
      await page.keyboard.down('Shift');
      await mouseDown('left');
      await mouseMove(44, 24);
      await mouseUp('left');
      await wheelDown();
      await page.keyboard.up('Control');
      await page.keyboard.up('Alt');
      await page.keyboard.up('Shift');
      assert.deepEqual(await getReports(encoding), [{col: 44, row: 25, state: {action: 'press', button: 'left', modifier: {control: false, shift: false, meta: false}}}]);
      */
    });
    it('URXVT encoding', async () => {
      // bug: always reports +1 for row/col (temp. fixed in parseReport to pass tests)
      const encoding = 'URXVT';
      await resetMouseModes();
      await mouseMove(0, 0);
      await page.evaluate(`window.term.write('\x1b[?9h\x1b[?1015h');`);

      // test at 0,0
      await mouseDown('left');
      assert.deepEqual(await getReports(encoding), [{col: 1, row: 1, state: {action: 'press', button: 'left', modifier: {control: false, shift: false, meta: false}}}]);

      // mouseup should not report
      await mouseUp('left');
      assert.deepEqual(await getReports(encoding), []);

      // mousemove should not report
      await mouseMove(50, 10);
      assert.deepEqual(await getReports(encoding), []);
      await mouseDown('left');
      await mouseUp('left');
      assert.deepEqual(await getReports(encoding), [{col: 51, row: 11, state: {action: 'press', button: 'left', modifier: {control: false, shift: false, meta: false}}}]);

      // test at max rows/cols
      await mouseMove(cols - 1, rows - 1);
      await mouseDown('left');
      await mouseUp('left');
      assert.deepEqual(await getReports(encoding), [{col: cols, row: rows, state: {action: 'press', button: 'left', modifier: {control: false, shift: false, meta: false}}}]);

      // button press/move/release tests
      // left button
      await mouseMove(43, 24);
      await getReports(encoding); // clear reports
      await mouseDown('left');
      await mouseMove(44, 24);
      await mouseUp('left');
      assert.deepEqual(await getReports(encoding), [{col: 44, row: 25, state: {action: 'press', button: 'left', modifier: {control: false, shift: false, meta: false}}}]);
      // middle button
      // bug: default action not cancelled (adds data to getReports from clipboard under X11)
      // await mouseMove(43, 24);
      // await getReports(encoding); // clear reports
      // await mouseDown('middle');
      // await mouseMove(44, 24);
      // await mouseUp('middle');
      // assert.deepEqual(await getReports(encoding), [{col: 44, row: 25, state: {action: 'press', button: 'middle', modifier: {control: false, shift: false, meta: false}}}]);
      // right button
      // bug: default action not cancelled (popup shown)
      await mouseMove(43, 24);
      await getReports(encoding); // clear reports
      await mouseDown('right');
      await mouseMove(44, 24);
      await mouseUp('right');
      assert.deepEqual(await getReports(encoding), [{col: 44, row: 25, state: {action: 'press', button: 'right', modifier: {control: false, shift: false, meta: false}}}]);

      // wheel
      await mouseMove(43, 24);
      await getReports(encoding); // clear reports
      await wheelUp();
      assert.deepEqual(await getReports(encoding), []);
      await wheelDown();
      assert.deepEqual(await getReports(encoding), []);

      // modifiers
      // CTRL
      await mouseMove(43, 24);
      await getReports(encoding); // clear reports
      await page.keyboard.down('Control');
      await mouseDown('left');
      await mouseMove(44, 24);
      await mouseUp('left');
      await wheelDown();
      await page.keyboard.up('Control');
      assert.deepEqual(await getReports(encoding), [{col: 44, row: 25, state: {action: 'press', button: 'left', modifier: {control: false, shift: false, meta: false}}}]);


      // ALT
      await mouseMove(43, 24);
      await getReports(encoding); // clear reports
      await page.keyboard.down('Alt');
      await mouseDown('left');
      await mouseMove(44, 24);
      await mouseUp('left');
      await wheelDown();
      await page.keyboard.up('Alt');
      assert.deepEqual(await getReports(encoding), [{col: 44, row: 25, state: {action: 'press', button: 'left', modifier: {control: false, shift: false, meta: false}}}]);

      // SHIFT
      // note: caught by selection manager
      await mouseMove(43, 24);
      await getReports(encoding); // clear reports
      await page.keyboard.down('Shift');  // defaults to ShiftLeft
      await mouseDown('left');
      await mouseMove(44, 24);
      await mouseUp('left');
      await wheelDown();
      await page.keyboard.up('Shift');
      if (noShift) {
        assert.deepEqual(await getReports(encoding), []);
      } else {
        assert.deepEqual(await getReports(encoding), [
          {col: 44, row: 25, state: {action: 'press', button: 'left', modifier: {control: false, shift: false, meta: false}}}
        ]);
      }
      /*
      // all modifiers
      // bug: this is totally broken with wrong coords and messed up modifiers
      await mouseMove(43, 24);
      await getReports(encoding); // clear reports
      await page.keyboard.down('Control');
      await page.keyboard.down('Alt');
      await page.keyboard.down('Shift');
      await mouseDown('left');
      await mouseMove(44, 24);
      await mouseUp('left');
      await wheelDown();
      await page.keyboard.up('Control');
      await page.keyboard.up('Alt');
      await page.keyboard.up('Shift');
      assert.deepEqual(await getReports(encoding), [{col: 44, row: 25, state: {action: 'press', button: 'left', modifier: {control: false, shift: false, meta: false}}}]);
      */
    });
  });
  describe('DECSET 1000 (VT200 mouse)', () => {
    /**
     * VT200 protocol:
     *  - press and release events
     *  - wheel up/down
     *  - no move
     *  - all modifiers
     */
    it('default encoding', async () => {
      const encoding = 'DEFAULT';
      await resetMouseModes();
      await mouseMove(0, 0);
      await page.evaluate(`window.term.write('\x1b[?1000h');`);

      // test at 0,0
      // bug: release is fired immediately - expected: only press event
      await mouseDown('left');
      assert.deepEqual(await getReports(encoding), [
        {col: 1, row: 1, state: {action: 'press', button: 'left', modifier: {control: false, shift: false, meta: false}}},
        {col: 1, row: 1, state: {action: 'release', button: '<none>', modifier: {control: false, shift: false, meta: false}}}
      ]);

      // mouseup should report, encoding cannot report released button
      // bug: release already fired thus no event here - expected: release event
      await mouseUp('left');
      assert.deepEqual(await getReports(encoding), []);

      // mousemove should not report
      await mouseMove(50, 10);
      assert.deepEqual(await getReports(encoding), []);
      await mouseDown('left');
      await mouseUp('left');
      assert.deepEqual(await getReports(encoding), [
        {col: 51, row: 11, state: {action: 'press', button: 'left', modifier: {control: false, shift: false, meta: false}}},
        {col: 51, row: 11, state: {action: 'release', button: '<none>', modifier: {control: false, shift: false, meta: false}}}
      ]);

      // test at max rows/cols
      // bug: we are capped at col 95 currently
      // fix: allow values up to 223, any bigger should drop to 0
      await mouseMove(cols - 1, rows - 1);
      await mouseDown('left');
      await mouseUp('left');
      assert.deepEqual(await getReports(encoding), [
        {col: 95, row: rows, state: {action: 'press', button: 'left', modifier: {control: false, shift: false, meta: false}}},
        {col: 95, row: rows, state: {action: 'release', button: '<none>', modifier: {control: false, shift: false, meta: false}}}
      ]);

      // button press/move/release tests
      // left button
      // bug: release is fired immediately thus with wrong coords - expected: col in release event should be 45
      await mouseMove(43, 24);
      await getReports(encoding); // clear reports
      await mouseDown('left');
      await mouseMove(44, 24);
      await mouseUp('left');
      assert.deepEqual(await getReports(encoding), [
        {col: 44, row: 25, state: {action: 'press', button: 'left', modifier: {control: false, shift: false, meta: false}}},
        {col: 44, row: 25, state: {action: 'release', button: '<none>', modifier: {control: false, shift: false, meta: false}}}
      ]);
      // middle button
      // bug: default action not cancelled (adds data to getReports from clipboard under X11)
      // await mouseMove(43, 24);
      // await getReports(encoding); // clear reports
      // await mouseDown('middle');
      // await mouseMove(44, 24);
      // await mouseUp('middle');
      // assert.deepEqual(await getReports(encoding), [{col: 44, row: 25, state: {action: 'press', button: 'middle', modifier: {control: false, shift: false, meta: false}}}]);
      // right button
      // bug: default action not cancelled (popup shown)
      // bug: release is fired immediately thus with wrong coords - expected: col in release event should be 45
      await mouseMove(43, 24);
      await getReports(encoding); // clear reports
      await mouseDown('right');
      await mouseMove(44, 24);
      await mouseUp('right');
      assert.deepEqual(await getReports(encoding), [
        {col: 44, row: 25, state: {action: 'press', button: 'right', modifier: {control: false, shift: false, meta: false}}},
        {col: 44, row: 25, state: {action: 'release', button: '<none>', modifier: {control: false, shift: false, meta: false}}}
      ]);

      // wheel
      await mouseMove(43, 24);
      await getReports(encoding); // clear reports
      await wheelUp();
      assert.deepEqual(await getReports(encoding), [{col: 44, row: 25, state: {action: 'up', button: 'wheel', modifier: {control: false, shift: false, meta: false}}}]);
      await wheelDown();
      assert.deepEqual(await getReports(encoding), [{col: 44, row: 25, state: {action: 'down', button: 'wheel', modifier: {control: false, shift: false, meta: false}}}]);

      // modifiers
      // CTRL
      // bug: totally broken - reports no modifier, reports wrong button and action, reports wrong coords for release
      // after fix: removed faulty reports below and uncomment lines
      await mouseMove(43, 24);
      await getReports(encoding); // clear reports
      // await page.keyboard.down('Control');
      await mouseDown('left');
      await mouseMove(44, 24);
      await mouseUp('left');
      await wheelDown();
      // await page.keyboard.up('Control');
      assert.deepEqual(await getReports(encoding), [
        {col: 44, row: 25, state: {action: 'press', button: 'left', modifier: {control: false, shift: false, meta: false}}},
        {col: 44, row: 25, state: {action: 'release', button: '<none>', modifier: {control: false, shift: false, meta: false}}},
        {col: 45, row: 25, state: {action: 'down', button: 'wheel', modifier: {control: false, shift: false, meta: false}}}
        // expected
        // {col: 44, row: 25, state: {action: 'press', button: 'left', modifier: {control: true, shift: false, meta: false}}},
        // {col: 45, row: 25, state: {action: 'release', button: '<none>', modifier: {control: true, shift: false, meta: false}}},
        // {col: 45, row: 25, state: {action: 'down', button: 'wheel', modifier: {control: true, shift: false, meta: false}}}
      ]);

      // ALT
      // bug: no modifier reported, release with wrong coords
      await mouseMove(43, 24);
      await getReports(encoding); // clear reports
      await page.keyboard.down('Alt');
      await mouseDown('left');
      await mouseMove(44, 24);
      await mouseUp('left');
      await wheelDown();
      await page.keyboard.up('Alt');
      assert.deepEqual(await getReports(encoding), [
        {col: 44, row: 25, state: {action: 'press', button: 'left', modifier: {control: false, shift: false, meta: false}}},
        {col: 44, row: 25, state: {action: 'release', button: '<none>', modifier: {control: false, shift: false, meta: false}}},
        {col: 45, row: 25, state: {action: 'down', button: 'wheel', modifier: {control: false, shift: false, meta: false}}}
        // expected
        // {col: 44, row: 25, state: {action: 'press', button: 'left', modifier: {control: false, shift: false, meta: true}}},
        // {col: 45, row: 25, state: {action: 'release', button: '<none>', modifier: {control: false, shift: false, meta: true}}},
        // {col: 45, row: 25, state: {action: 'down', button: 'wheel', modifier: {control: false, shift: false, meta: true}}}
      ]);

      // SHIFT
      // note: press/release caught by selection manager
      // bug: modifier not reported for passed events
      await mouseMove(43, 24);
      await getReports(encoding); // clear reports
      await page.keyboard.down('Shift');  // defaults to ShiftLeft
      await mouseDown('left');
      await mouseMove(44, 24);
      await mouseUp('left');
      await wheelDown();
      await page.keyboard.up('Shift');
      if (noShift) {
        assert.deepEqual(await getReports(encoding), [
          {col: 45, row: 25, state: {action: 'down', button: 'wheel', modifier: {control: false, shift: false, meta: false}}}
        ]);
      } else {
        assert.deepEqual(await getReports(encoding), [
          {col: 44, row: 25, state: {action: 'press', button: 'left', modifier: {control: false, shift: false, meta: false}}},
          {col: 44, row: 25, state: {action: 'release', button: '<none>', modifier: {control: false, shift: false, meta: false}}},
          {col: 45, row: 25, state: {action: 'down', button: 'wheel', modifier: {control: false, shift: false, meta: false}}}
        ]);
      }

      /*
      // all modifiers
      // bug: this is totally broken with wrong coords and messed up modifiers
      await mouseMove(43, 24);
      await getReports(encoding); // clear reports
      await page.keyboard.down('Control');
      await page.keyboard.down('Alt');
      await page.keyboard.down('Shift');
      await mouseDown('left');
      await mouseMove(44, 24);
      await mouseUp('left');
      await wheelDown();
      await page.keyboard.up('Control');
      await page.keyboard.up('Alt');
      await page.keyboard.up('Shift');
      assert.deepEqual(await getReports(encoding), [
        {col: 44, row: 25, state: {action: 'press', button: 'left', modifier: {control: true, shift: true, meta: true}}},
        {col: 45, row: 25, state: {action: 'release', button: '<none>', modifier: {control: true, shift: true, meta: true}}},
        {col: 45, row: 25, state: {action: 'down', button: 'wheel', modifier: {control: true, shift: true, meta: true}}}
      ]);
      */
    });
    it('UTF8 encoding', async () => {
      const encoding = 'UTF8';
      await resetMouseModes();
      await mouseMove(0, 0);
      await page.evaluate(`window.term.write('\x1b[?1000h\x1b[?1005h');`);

      // test at 0,0
      // bug: release is fired immediately - expected: only press event
      await mouseDown('left');
      assert.deepEqual(await getReports(encoding), [
        {col: 1, row: 1, state: {action: 'press', button: 'left', modifier: {control: false, shift: false, meta: false}}},
        {col: 1, row: 1, state: {action: 'release', button: '<none>', modifier: {control: false, shift: false, meta: false}}}
      ]);

      // mouseup should report, encoding cannot report released button
      // bug: release already fired thus no event here - expected: release event
      await mouseUp('left');
      assert.deepEqual(await getReports(encoding), []);

      // mousemove should not report
      await mouseMove(50, 10);
      assert.deepEqual(await getReports(encoding), []);
      await mouseDown('left');
      await mouseUp('left');
      assert.deepEqual(await getReports(encoding), [
        {col: 51, row: 11, state: {action: 'press', button: 'left', modifier: {control: false, shift: false, meta: false}}},
        {col: 51, row: 11, state: {action: 'release', button: '<none>', modifier: {control: false, shift: false, meta: false}}}
      ]);

      // test at max rows/cols
      await mouseMove(cols - 1, rows - 1);
      await mouseDown('left');
      await mouseUp('left');
      assert.deepEqual(await getReports(encoding), [
        {col: cols, row: rows, state: {action: 'press', button: 'left', modifier: {control: false, shift: false, meta: false}}},
        {col: cols, row: rows, state: {action: 'release', button: '<none>', modifier: {control: false, shift: false, meta: false}}}
      ]);

      // button press/move/release tests
      // left button
      // bug: release is fired immediately thus with wrong coords - expected: col in release event should be 45
      await mouseMove(43, 24);
      await getReports(encoding); // clear reports
      await mouseDown('left');
      await mouseMove(44, 24);
      await mouseUp('left');
      assert.deepEqual(await getReports(encoding), [
        {col: 44, row: 25, state: {action: 'press', button: 'left', modifier: {control: false, shift: false, meta: false}}},
        {col: 44, row: 25, state: {action: 'release', button: '<none>', modifier: {control: false, shift: false, meta: false}}}
      ]);
      // middle button
      // bug: default action not cancelled (adds data to getReports from clipboard under X11)
      // await mouseMove(43, 24);
      // await getReports(encoding); // clear reports
      // await mouseDown('middle');
      // await mouseMove(44, 24);
      // await mouseUp('middle');
      // assert.deepEqual(await getReports(encoding), [{col: 44, row: 25, state: {action: 'press', button: 'middle', modifier: {control: false, shift: false, meta: false}}}]);
      // right button
      // bug: default action not cancelled (popup shown)
      // bug: release is fired immediately thus with wrong coords - expected: col in release event should be 45
      await mouseMove(43, 24);
      await getReports(encoding); // clear reports
      await mouseDown('right');
      await mouseMove(44, 24);
      await mouseUp('right');
      assert.deepEqual(await getReports(encoding), [
        {col: 44, row: 25, state: {action: 'press', button: 'right', modifier: {control: false, shift: false, meta: false}}},
        {col: 44, row: 25, state: {action: 'release', button: '<none>', modifier: {control: false, shift: false, meta: false}}}
      ]);

      // wheel
      await mouseMove(43, 24);
      await getReports(encoding); // clear reports
      await wheelUp();
      assert.deepEqual(await getReports(encoding), [{col: 44, row: 25, state: {action: 'up', button: 'wheel', modifier: {control: false, shift: false, meta: false}}}]);
      await wheelDown();
      assert.deepEqual(await getReports(encoding), [{col: 44, row: 25, state: {action: 'down', button: 'wheel', modifier: {control: false, shift: false, meta: false}}}]);

      // modifiers
      // CTRL
      // bug: totally broken - reports no modifier, reports wrong button and action, reports wrong coords for release
      // after fix: removed faulty reports below and uncomment lines
      await mouseMove(43, 24);
      await getReports(encoding); // clear reports
      // await page.keyboard.down('Control');
      await mouseDown('left');
      await mouseMove(44, 24);
      await mouseUp('left');
      await wheelDown();
      // await page.keyboard.up('Control');
      assert.deepEqual(await getReports(encoding), [
        {col: 44, row: 25, state: {action: 'press', button: 'left', modifier: {control: false, shift: false, meta: false}}},
        {col: 44, row: 25, state: {action: 'release', button: '<none>', modifier: {control: false, shift: false, meta: false}}},
        {col: 45, row: 25, state: {action: 'down', button: 'wheel', modifier: {control: false, shift: false, meta: false}}}
        // expected
        // {col: 44, row: 25, state: {action: 'press', button: 'left', modifier: {control: true, shift: false, meta: false}}},
        // {col: 45, row: 25, state: {action: 'release', button: '<none>', modifier: {control: true, shift: false, meta: false}}},
        // {col: 45, row: 25, state: {action: 'down', button: 'wheel', modifier: {control: true, shift: false, meta: false}}}
      ]);

      // ALT
      // bug: no modifier reported, release with wrong coords
      await mouseMove(43, 24);
      await getReports(encoding); // clear reports
      await page.keyboard.down('Alt');
      await mouseDown('left');
      await mouseMove(44, 24);
      await mouseUp('left');
      await wheelDown();
      await page.keyboard.up('Alt');
      assert.deepEqual(await getReports(encoding), [
        {col: 44, row: 25, state: {action: 'press', button: 'left', modifier: {control: false, shift: false, meta: false}}},
        {col: 44, row: 25, state: {action: 'release', button: '<none>', modifier: {control: false, shift: false, meta: false}}},
        {col: 45, row: 25, state: {action: 'down', button: 'wheel', modifier: {control: false, shift: false, meta: false}}}
        // expected
        // {col: 44, row: 25, state: {action: 'press', button: 'left', modifier: {control: false, shift: false, meta: true}}},
        // {col: 45, row: 25, state: {action: 'release', button: '<none>', modifier: {control: false, shift: false, meta: true}}},
        // {col: 45, row: 25, state: {action: 'down', button: 'wheel', modifier: {control: false, shift: false, meta: true}}}
      ]);

      // SHIFT
      // note: press/release caught by selection manager
      // bug: modifier not reported for passed events
      await mouseMove(43, 24);
      await getReports(encoding); // clear reports
      await page.keyboard.down('Shift');  // defaults to ShiftLeft
      await mouseDown('left');
      await mouseMove(44, 24);
      await mouseUp('left');
      await wheelDown();
      await page.keyboard.up('Shift');
      if (noShift) {
        assert.deepEqual(await getReports(encoding), [
          {col: 45, row: 25, state: {action: 'down', button: 'wheel', modifier: {control: false, shift: false, meta: false}}}
        ]);
      } else {
        assert.deepEqual(await getReports(encoding), [
          {col: 44, row: 25, state: {action: 'press', button: 'left', modifier: {control: false, shift: false, meta: false}}},
          {col: 44, row: 25, state: {action: 'release', button: '<none>', modifier: {control: false, shift: false, meta: false}}},
          {col: 45, row: 25, state: {action: 'down', button: 'wheel', modifier: {control: false, shift: false, meta: false}}}
        ]);
      }

      /*
      // all modifiers
      // bug: this is totally broken with wrong coords and messed up modifiers
      await mouseMove(43, 24);
      await getReports(encoding); // clear reports
      await page.keyboard.down('Control');
      await page.keyboard.down('Alt');
      await page.keyboard.down('Shift');
      await mouseDown('left');
      await mouseMove(44, 24);
      await mouseUp('left');
      await wheelDown();
      await page.keyboard.up('Control');
      await page.keyboard.up('Alt');
      await page.keyboard.up('Shift');
      assert.deepEqual(await getReports(encoding), [
        {col: 44, row: 25, state: {action: 'press', button: 'left', modifier: {control: true, shift: true, meta: true}}},
        {col: 45, row: 25, state: {action: 'release', button: '<none>', modifier: {control: true, shift: true, meta: true}}},
        {col: 45, row: 25, state: {action: 'down', button: 'wheel', modifier: {control: true, shift: true, meta: true}}}
      ]);
      */
    });
    it('SGR encoding', async () => {
      const encoding = 'SGR';
      await resetMouseModes();
      await mouseMove(0, 0);
      await page.evaluate(`window.term.write('\x1b[?1000h\x1b[?1006h');`);

      // test at 0,0
      // bug: release is fired immediately - expected: only press event
      await mouseDown('left');
      assert.deepEqual(await getReports(encoding), [
        {col: 1, row: 1, state: {action: 'press', button: 'left', modifier: {control: false, shift: false, meta: false}}},
        {col: 1, row: 1, state: {action: 'release', button: 'left', modifier: {control: false, shift: false, meta: false}}}
      ]);

      // mouseup should report
      // bug: release already fired thus no event here - expected: release event
      await mouseUp('left');
      assert.deepEqual(await getReports(encoding), []);

      // mousemove should not report
      await mouseMove(50, 10);
      assert.deepEqual(await getReports(encoding), []);
      await mouseDown('left');
      await mouseUp('left');
      assert.deepEqual(await getReports(encoding), [
        {col: 51, row: 11, state: {action: 'press', button: 'left', modifier: {control: false, shift: false, meta: false}}},
        {col: 51, row: 11, state: {action: 'release', button: 'left', modifier: {control: false, shift: false, meta: false}}}
      ]);

      // test at max rows/cols
      await mouseMove(cols - 1, rows - 1);
      await mouseDown('left');
      await mouseUp('left');
      assert.deepEqual(await getReports(encoding), [
        {col: cols, row: rows, state: {action: 'press', button: 'left', modifier: {control: false, shift: false, meta: false}}},
        {col: cols, row: rows, state: {action: 'release', button: 'left', modifier: {control: false, shift: false, meta: false}}}
      ]);

      // button press/move/release tests
      // left button
      // bug: release is fired immediately thus with wrong coords - expected: col in release event should be 45
      await mouseMove(43, 24);
      await getReports(encoding); // clear reports
      await mouseDown('left');
      await mouseMove(44, 24);
      await mouseUp('left');
      assert.deepEqual(await getReports(encoding), [
        {col: 44, row: 25, state: {action: 'press', button: 'left', modifier: {control: false, shift: false, meta: false}}},
        {col: 44, row: 25, state: {action: 'release', button: 'left', modifier: {control: false, shift: false, meta: false}}}
      ]);
      // middle button
      // bug: default action not cancelled (adds data to getReports from clipboard under X11)
      // await mouseMove(43, 24);
      // await getReports(encoding); // clear reports
      // await mouseDown('middle');
      // await mouseMove(44, 24);
      // await mouseUp('middle');
      // assert.deepEqual(await getReports(encoding), [{col: 44, row: 25, state: {action: 'press', button: 'middle', modifier: {control: false, shift: false, meta: false}}}]);
      // right button
      // bug: default action not cancelled (popup shown)
      // bug: release is fired immediately thus with wrong coords - expected: col in release event should be 45
      // bug: release reports wrong button
      await mouseMove(43, 24);
      await getReports(encoding); // clear reports
      await mouseDown('right');
      await mouseMove(44, 24);
      await mouseUp('right');
      assert.deepEqual(await getReports(encoding), [
        {col: 44, row: 25, state: {action: 'press', button: 'right', modifier: {control: false, shift: false, meta: false}}},
        {col: 44, row: 25, state: {action: 'release', button: 'left', modifier: {control: false, shift: false, meta: false}}}
      ]);

      // wheel
      await mouseMove(43, 24);
      await getReports(encoding); // clear reports
      await wheelUp();
      assert.deepEqual(await getReports(encoding), [{col: 44, row: 25, state: {action: 'up', button: 'wheel', modifier: {control: false, shift: false, meta: false}}}]);
      await wheelDown();
      assert.deepEqual(await getReports(encoding), [{col: 44, row: 25, state: {action: 'down', button: 'wheel', modifier: {control: false, shift: false, meta: false}}}]);

      // modifiers
      // CTRL
      // bug: totally broken - reports no modifier, reports wrong button and action, reports wrong coords for release
      // after fix: removed faulty reports below and uncomment lines
      await mouseMove(43, 24);
      await getReports(encoding); // clear reports
      // await page.keyboard.down('Control');
      await mouseDown('left');
      await mouseMove(44, 24);
      await mouseUp('left');
      await wheelDown();
      // await page.keyboard.up('Control');
      assert.deepEqual(await getReports(encoding), [
        {col: 44, row: 25, state: {action: 'press', button: 'left', modifier: {control: false, shift: false, meta: false}}},
        {col: 44, row: 25, state: {action: 'release', button: 'left', modifier: {control: false, shift: false, meta: false}}},
        {col: 45, row: 25, state: {action: 'down', button: 'wheel', modifier: {control: false, shift: false, meta: false}}}
        // expected
        // {col: 44, row: 25, state: {action: 'press', button: 'left', modifier: {control: true, shift: false, meta: false}}},
        // {col: 45, row: 25, state: {action: 'release', button: '<none>', modifier: {control: true, shift: false, meta: false}}},
        // {col: 45, row: 25, state: {action: 'down', button: 'wheel', modifier: {control: true, shift: false, meta: false}}}
      ]);

      // ALT
      // bug: no modifier reported, release with wrong coords
      await mouseMove(43, 24);
      await getReports(encoding); // clear reports
      await page.keyboard.down('Alt');
      await mouseDown('left');
      await mouseMove(44, 24);
      await mouseUp('left');
      await wheelDown();
      await page.keyboard.up('Alt');
      assert.deepEqual(await getReports(encoding), [
        {col: 44, row: 25, state: {action: 'press', button: 'left', modifier: {control: false, shift: false, meta: false}}},
        {col: 44, row: 25, state: {action: 'release', button: 'left', modifier: {control: false, shift: false, meta: false}}},
        {col: 45, row: 25, state: {action: 'down', button: 'wheel', modifier: {control: false, shift: false, meta: false}}}
        // expected
        // {col: 44, row: 25, state: {action: 'press', button: 'left', modifier: {control: false, shift: false, meta: true}}},
        // {col: 45, row: 25, state: {action: 'release', button: '<none>', modifier: {control: false, shift: false, meta: true}}},
        // {col: 45, row: 25, state: {action: 'down', button: 'wheel', modifier: {control: false, shift: false, meta: true}}}
      ]);

      // SHIFT
      // note: press/release caught by selection manager
      // bug: modifier not reported for passed events
      await mouseMove(43, 24);
      await getReports(encoding); // clear reports
      await page.keyboard.down('Shift');  // defaults to ShiftLeft
      await mouseDown('left');
      await mouseMove(44, 24);
      await mouseUp('left');
      await wheelDown();
      await page.keyboard.up('Shift');
      if (noShift) {
        assert.deepEqual(await getReports(encoding), [
          {col: 45, row: 25, state: {action: 'down', button: 'wheel', modifier: {control: false, shift: false, meta: false}}}
        ]);
      } else {
        assert.deepEqual(await getReports(encoding), [
          {col: 44, row: 25, state: {action: 'press', button: 'left', modifier: {control: false, shift: false, meta: false}}},
          {col: 44, row: 25, state: {action: 'release', button: 'left', modifier: {control: false, shift: false, meta: false}}},
          {col: 45, row: 25, state: {action: 'down', button: 'wheel', modifier: {control: false, shift: false, meta: false}}}
        ]);
      }

      /*
      // all modifiers
      // bug: this is totally broken with wrong coords and messed up modifiers
      await mouseMove(43, 24);
      await getReports(encoding); // clear reports
      await page.keyboard.down('Control');
      await page.keyboard.down('Alt');
      await page.keyboard.down('Shift');
      await mouseDown('left');
      await mouseMove(44, 24);
      await mouseUp('left');
      await wheelDown();
      await page.keyboard.up('Control');
      await page.keyboard.up('Alt');
      await page.keyboard.up('Shift');
      assert.deepEqual(await getReports(encoding), [
        {col: 44, row: 25, state: {action: 'press', button: 'left', modifier: {control: true, shift: true, meta: true}}},
        {col: 45, row: 25, state: {action: 'release', button: 'left', modifier: {control: true, shift: true, meta: true}}},
        {col: 45, row: 25, state: {action: 'down', button: 'wheel', modifier: {control: true, shift: true, meta: true}}}
      ]);
      */
    });
    it('URXVT encoding', async () => {
      const encoding = 'URXVT';
      await resetMouseModes();
      await mouseMove(0, 0);
      await page.evaluate(`window.term.write('\x1b[?1000h\x1b[?1015h');`);

      // test at 0,0
      // bug: release is fired immediately - expected: only press event
      await mouseDown('left');
      assert.deepEqual(await getReports(encoding), [
        {col: 1, row: 1, state: {action: 'press', button: 'left', modifier: {control: false, shift: false, meta: false}}},
        {col: 1, row: 1, state: {action: 'release', button: '<none>', modifier: {control: false, shift: false, meta: false}}}
      ]);

      // mouseup should report, encoding cannot report released button
      // bug: release already fired thus no event here - expected: release event
      await mouseUp('left');
      assert.deepEqual(await getReports(encoding), []);

      // mousemove should not report
      await mouseMove(50, 10);
      assert.deepEqual(await getReports(encoding), []);
      await mouseDown('left');
      await mouseUp('left');
      assert.deepEqual(await getReports(encoding), [
        {col: 51, row: 11, state: {action: 'press', button: 'left', modifier: {control: false, shift: false, meta: false}}},
        {col: 51, row: 11, state: {action: 'release', button: '<none>', modifier: {control: false, shift: false, meta: false}}}
      ]);

      // test at max rows/cols
      await mouseMove(cols - 1, rows - 1);
      await mouseDown('left');
      await mouseUp('left');
      assert.deepEqual(await getReports(encoding), [
        {col: cols, row: rows, state: {action: 'press', button: 'left', modifier: {control: false, shift: false, meta: false}}},
        {col: cols, row: rows, state: {action: 'release', button: '<none>', modifier: {control: false, shift: false, meta: false}}}
      ]);

      // button press/move/release tests
      // left button
      // bug: release is fired immediately thus with wrong coords - expected: col in release event should be 45
      await mouseMove(43, 24);
      await getReports(encoding); // clear reports
      await mouseDown('left');
      await mouseMove(44, 24);
      await mouseUp('left');
      assert.deepEqual(await getReports(encoding), [
        {col: 44, row: 25, state: {action: 'press', button: 'left', modifier: {control: false, shift: false, meta: false}}},
        {col: 44, row: 25, state: {action: 'release', button: '<none>', modifier: {control: false, shift: false, meta: false}}}
      ]);
      // middle button
      // bug: default action not cancelled (adds data to getReports from clipboard under X11)
      // await mouseMove(43, 24);
      // await getReports(encoding); // clear reports
      // await mouseDown('middle');
      // await mouseMove(44, 24);
      // await mouseUp('middle');
      // assert.deepEqual(await getReports(encoding), [{col: 44, row: 25, state: {action: 'press', button: 'middle', modifier: {control: false, shift: false, meta: false}}}]);
      // right button
      // bug: default action not cancelled (popup shown)
      // bug: release is fired immediately thus with wrong coords - expected: col in release event should be 45
      await mouseMove(43, 24);
      await getReports(encoding); // clear reports
      await mouseDown('right');
      await mouseMove(44, 24);
      await mouseUp('right');
      assert.deepEqual(await getReports(encoding), [
        {col: 44, row: 25, state: {action: 'press', button: 'right', modifier: {control: false, shift: false, meta: false}}},
        {col: 44, row: 25, state: {action: 'release', button: '<none>', modifier: {control: false, shift: false, meta: false}}}
      ]);

      // wheel
      await mouseMove(43, 24);
      await getReports(encoding); // clear reports
      await wheelUp();
      assert.deepEqual(await getReports(encoding), [{col: 44, row: 25, state: {action: 'up', button: 'wheel', modifier: {control: false, shift: false, meta: false}}}]);
      await wheelDown();
      assert.deepEqual(await getReports(encoding), [{col: 44, row: 25, state: {action: 'down', button: 'wheel', modifier: {control: false, shift: false, meta: false}}}]);

      // modifiers
      // CTRL
      // bug: totally broken - reports no modifier, reports wrong button and action, reports wrong coords for release
      // after fix: removed faulty reports below and uncomment lines
      await mouseMove(43, 24);
      await getReports(encoding); // clear reports
      // await page.keyboard.down('Control');
      await mouseDown('left');
      await mouseMove(44, 24);
      await mouseUp('left');
      await wheelDown();
      // await page.keyboard.up('Control');
      assert.deepEqual(await getReports(encoding), [
        {col: 44, row: 25, state: {action: 'press', button: 'left', modifier: {control: false, shift: false, meta: false}}},
        {col: 44, row: 25, state: {action: 'release', button: '<none>', modifier: {control: false, shift: false, meta: false}}},
        {col: 45, row: 25, state: {action: 'down', button: 'wheel', modifier: {control: false, shift: false, meta: false}}}
        // expected
        // {col: 44, row: 25, state: {action: 'press', button: 'left', modifier: {control: true, shift: false, meta: false}}},
        // {col: 45, row: 25, state: {action: 'release', button: '<none>', modifier: {control: true, shift: false, meta: false}}},
        // {col: 45, row: 25, state: {action: 'down', button: 'wheel', modifier: {control: true, shift: false, meta: false}}}
      ]);

      // ALT
      // bug: no modifier reported, release with wrong coords
      await mouseMove(43, 24);
      await getReports(encoding); // clear reports
      await page.keyboard.down('Alt');
      await mouseDown('left');
      await mouseMove(44, 24);
      await mouseUp('left');
      await wheelDown();
      await page.keyboard.up('Alt');
      assert.deepEqual(await getReports(encoding), [
        {col: 44, row: 25, state: {action: 'press', button: 'left', modifier: {control: false, shift: false, meta: false}}},
        {col: 44, row: 25, state: {action: 'release', button: '<none>', modifier: {control: false, shift: false, meta: false}}},
        {col: 45, row: 25, state: {action: 'down', button: 'wheel', modifier: {control: false, shift: false, meta: false}}}
        // expected
        // {col: 44, row: 25, state: {action: 'press', button: 'left', modifier: {control: false, shift: false, meta: true}}},
        // {col: 45, row: 25, state: {action: 'release', button: '<none>', modifier: {control: false, shift: false, meta: true}}},
        // {col: 45, row: 25, state: {action: 'down', button: 'wheel', modifier: {control: false, shift: false, meta: true}}}
      ]);

      // SHIFT
      // note: press/release caught by selection manager
      // bug: modifier not reported for passed events
      await mouseMove(43, 24);
      await getReports(encoding); // clear reports
      await page.keyboard.down('Shift');  // defaults to ShiftLeft
      await mouseDown('left');
      await mouseMove(44, 24);
      await mouseUp('left');
      await wheelDown();
      await page.keyboard.up('Shift');
      if (noShift) {
        assert.deepEqual(await getReports(encoding), [
          {col: 45, row: 25, state: {action: 'down', button: 'wheel', modifier: {control: false, shift: false, meta: false}}}
        ]);
      } else {
        assert.deepEqual(await getReports(encoding), [
          {col: 44, row: 25, state: {action: 'press', button: 'left', modifier: {control: false, shift: false, meta: false}}},
          {col: 44, row: 25, state: {action: 'release', button: '<none>', modifier: {control: false, shift: false, meta: false}}},
          {col: 45, row: 25, state: {action: 'down', button: 'wheel', modifier: {control: false, shift: false, meta: false}}}
        ]);
      }

      /*
      // all modifiers
      // bug: this is totally broken with wrong coords and messed up modifiers
      await mouseMove(43, 24);
      await getReports(encoding); // clear reports
      await page.keyboard.down('Control');
      await page.keyboard.down('Alt');
      await page.keyboard.down('Shift');
      await mouseDown('left');
      await mouseMove(44, 24);
      await mouseUp('left');
      await wheelDown();
      await page.keyboard.up('Control');
      await page.keyboard.up('Alt');
      await page.keyboard.up('Shift');
      assert.deepEqual(await getReports(encoding), [
        {col: 44, row: 25, state: {action: 'press', button: 'left', modifier: {control: true, shift: true, meta: true}}},
        {col: 45, row: 25, state: {action: 'release', button: '<none>', modifier: {control: true, shift: true, meta: true}}},
        {col: 45, row: 25, state: {action: 'down', button: 'wheel', modifier: {control: true, shift: true, meta: true}}}
      ]);
      */
    });
  });
  describe('DECSET 1002 (xterm with drag)', () => {
    /**
     * VT200 protocol:
     *  - press and release events
     *  - wheel up/down
     *  - move only on press (drag)
     *  - all modifiers
     * Note: tmux runs this with SGR encoding.
     */
    it('default encoding', async () => {
      const encoding = 'DEFAULT';
      await resetMouseModes();
      await mouseMove(0, 0);
      await page.evaluate(`window.term.write('\x1b[?1002h');`);

      // test at 0,0
      await mouseDown('left');
      assert.deepEqual(await getReports(encoding), [
        {col: 1, row: 1, state: {action: 'press', button: 'left', modifier: {control: false, shift: false, meta: false}}}
      ]);

      // mouseup should report, encoding cannot report released button
      await mouseUp('left');
      assert.deepEqual(await getReports(encoding), [
        {col: 1, row: 1, state: {action: 'release', button: '<none>', modifier: {control: false, shift: false, meta: false}}}
      ]);

      // mousemove should not report
      await mouseMove(50, 10);
      assert.deepEqual(await getReports(encoding), []);
      await mouseDown('left');
      await mouseUp('left');
      assert.deepEqual(await getReports(encoding), [
        {col: 51, row: 11, state: {action: 'press', button: 'left', modifier: {control: false, shift: false, meta: false}}},
        {col: 51, row: 11, state: {action: 'release', button: '<none>', modifier: {control: false, shift: false, meta: false}}}
      ]);

      // test at max rows/cols
      // bug: we are capped at col 95 currently
      // fix: allow values up to 223, any bigger should drop to 0
      await mouseMove(cols - 1, rows - 1);
      await mouseDown('left');
      await mouseUp('left');
      assert.deepEqual(await getReports(encoding), [
        {col: 95, row: rows, state: {action: 'press', button: 'left', modifier: {control: false, shift: false, meta: false}}},
        {col: 95, row: rows, state: {action: 'release', button: '<none>', modifier: {control: false, shift: false, meta: false}}}
      ]);

      // button press/move/release tests
      // left button
      await mouseMove(43, 24);
      await getReports(encoding); // clear reports
      await mouseDown('left');
      await mouseMove(44, 24);
      await mouseUp('left');
      assert.deepEqual(await getReports(encoding), [
        {col: 44, row: 25, state: {action: 'press', button: 'left', modifier: {control: false, shift: false, meta: false}}},
        {col: 45, row: 25, state: {action: 'move', button: 'left', modifier: {control: false, shift: false, meta: false}}},
        {col: 45, row: 25, state: {action: 'release', button: '<none>', modifier: {control: false, shift: false, meta: false}}}
      ]);
      // middle button
      // bug: default action not cancelled (adds data to getReports from clipboard under X11)
      // await mouseMove(43, 24);
      // await getReports(encoding); // clear reports
      // await mouseDown('middle');
      // await mouseMove(44, 24);
      // await mouseUp('middle');
      // assert.deepEqual(await getReports(encoding), [{col: 44, row: 25, state: {action: 'press', button: 'middle', modifier: {control: false, shift: false, meta: false}}}]);
      // right button
      // bug: default action not cancelled (popup shown)
      await mouseMove(43, 24);
      await getReports(encoding); // clear reports
      await mouseDown('right');
      await mouseMove(44, 24);
      await mouseUp('right');
      assert.deepEqual(await getReports(encoding), [
        {col: 44, row: 25, state: {action: 'press', button: 'right', modifier: {control: false, shift: false, meta: false}}},
        {col: 45, row: 25, state: {action: 'move', button: 'right', modifier: {control: false, shift: false, meta: false}}},
        {col: 45, row: 25, state: {action: 'release', button: '<none>', modifier: {control: false, shift: false, meta: false}}}
      ]);

      // wheel
      await mouseMove(43, 24);
      await getReports(encoding); // clear reports
      await wheelUp();
      assert.deepEqual(await getReports(encoding), [{col: 44, row: 25, state: {action: 'up', button: 'wheel', modifier: {control: false, shift: false, meta: false}}}]);
      await wheelDown();
      assert.deepEqual(await getReports(encoding), [{col: 44, row: 25, state: {action: 'down', button: 'wheel', modifier: {control: false, shift: false, meta: false}}}]);

      // modifiers
      // CTRL
      // bug: totally broken - reports no modifier, reports wrong button and action
      // after fix: removed faulty reports below and uncomment lines
      await mouseMove(43, 24);
      await getReports(encoding); // clear reports
      // await page.keyboard.down('Control');
      await mouseDown('left');
      await mouseMove(44, 24);
      await mouseUp('left');
      await wheelDown();
      // await page.keyboard.up('Control');
      assert.deepEqual(await getReports(encoding), [
        {col: 44, row: 25, state: {action: 'press', button: 'left', modifier: {control: false, shift: false, meta: false}}},
        {col: 45, row: 25, state: {action: 'move', button: 'left', modifier: {control: false, shift: false, meta: false}}},
        {col: 45, row: 25, state: {action: 'release', button: '<none>', modifier: {control: false, shift: false, meta: false}}},
        {col: 45, row: 25, state: {action: 'down', button: 'wheel', modifier: {control: false, shift: false, meta: false}}}
        // expected
        // {col: 44, row: 25, state: {action: 'press', button: 'left', modifier: {control: true, shift: false, meta: false}}},
        // {col: 45, row: 25, state: {action: 'move', button: 'left', modifier: {control: true, shift: false, meta: false}}},
        // {col: 45, row: 25, state: {action: 'release', button: '<none>', modifier: {control: true, shift: false, meta: false}}},
        // {col: 45, row: 25, state: {action: 'down', button: 'wheel', modifier: {control: true, shift: false, meta: false}}}
      ]);

      // ALT
      // bug: no modifier reported
      await mouseMove(43, 24);
      await getReports(encoding); // clear reports
      await page.keyboard.down('Alt');
      await mouseDown('left');
      await mouseMove(44, 24);
      await mouseUp('left');
      await wheelDown();
      await page.keyboard.up('Alt');
      assert.deepEqual(await getReports(encoding), [
        {col: 44, row: 25, state: {action: 'press', button: 'left', modifier: {control: false, shift: false, meta: false}}},
        {col: 45, row: 25, state: {action: 'move', button: 'left', modifier: {control: false, shift: false, meta: false}}},
        {col: 45, row: 25, state: {action: 'release', button: '<none>', modifier: {control: false, shift: false, meta: false}}},
        {col: 45, row: 25, state: {action: 'down', button: 'wheel', modifier: {control: false, shift: false, meta: false}}}
        // expected
        // {col: 44, row: 25, state: {action: 'press', button: 'left', modifier: {control: false, shift: false, meta: true}}},
        // {col: 45, row: 25, state: {action: 'move', button: 'left', modifier: {control: false, shift: false, meta: true}}},
        // {col: 45, row: 25, state: {action: 'release', button: '<none>', modifier: {control: false, shift: false, meta: true}}},
        // {col: 45, row: 25, state: {action: 'down', button: 'wheel', modifier: {control: false, shift: false, meta: true}}}
      ]);

      // SHIFT
      // note: press/release/drag caught by selection manager
      // bug: modifier not reported for passed events
      await mouseMove(43, 24);
      await getReports(encoding); // clear reports
      await page.keyboard.down('Shift');  // defaults to ShiftLeft
      await mouseDown('left');
      await mouseMove(44, 24);
      await mouseUp('left');
      await wheelDown();
      await page.keyboard.up('Shift');
      if (noShift) {
        assert.deepEqual(await getReports(encoding), [
          {col: 45, row: 25, state: {action: 'down', button: 'wheel', modifier: {control: false, shift: false, meta: false}}}
        ]);
      } else {
        // bug: completely messed up - wrong modifier, only partially reported
        assert.deepEqual(await getReports(encoding), [
          {col: 44, row: 25, state: {action: 'press', button: 'left', modifier: {control: true, shift: false, meta: false}}},
          {col: 45, row: 25, state: {action: 'move', button: 'left', modifier: {control: true, shift: false, meta: false}}},
          {col: 45, row: 25, state: {action: 'release', button: '<none>', modifier: {control: true, shift: false, meta: false}}},
          {col: 45, row: 25, state: {action: 'down', button: 'wheel', modifier: {control: false, shift: false, meta: false}}}
        ]);
      }

      /*
      // all modifiers
      // bug: this is totally broken with wrong coords and messed up modifiers
      await mouseMove(43, 24);
      await getReports(encoding); // clear reports
      await page.keyboard.down('Control');
      await page.keyboard.down('Alt');
      await page.keyboard.down('Shift');
      await mouseDown('left');
      await mouseMove(44, 24);
      await mouseUp('left');
      await wheelDown();
      await page.keyboard.up('Control');
      await page.keyboard.up('Alt');
      await page.keyboard.up('Shift');
      assert.deepEqual(await getReports(encoding), [
        {col: 44, row: 25, state: {action: 'press', button: 'left', modifier: {control: true, shift: true, meta: true}}},
        {col: 45, row: 25, state: {action: 'move', button: 'left', modifier: {control: true, shift: true, meta: true}}},
        {col: 45, row: 25, state: {action: 'release', button: '<none>', modifier: {control: true, shift: true, meta: true}}},
        {col: 45, row: 25, state: {action: 'down', button: 'wheel', modifier: {control: true, shift: true, meta: true}}}
      ]);
      */
    });
    it('UTF8 encoding', async () => {
      const encoding = 'UTF8';
      await resetMouseModes();
      await mouseMove(0, 0);
      await page.evaluate(`window.term.write('\x1b[?1002h\x1b[?1005h');`);

      // test at 0,0
      // bug: release is fired immediately
      await mouseDown('left');
      assert.deepEqual(await getReports(encoding), [
        {col: 1, row: 1, state: {action: 'press', button: 'left', modifier: {control: false, shift: false, meta: false}}}
      ]);

      // mouseup should report, encoding cannot report released button
      // bug: release already fired thus no event here - expected: release event
      await mouseUp('left');
      assert.deepEqual(await getReports(encoding), [
        {col: 1, row: 1, state: {action: 'release', button: '<none>', modifier: {control: false, shift: false, meta: false}}}
      ]);

      // mousemove should not report
      await mouseMove(50, 10);
      assert.deepEqual(await getReports(encoding), []);
      await mouseDown('left');
      await mouseUp('left');
      assert.deepEqual(await getReports(encoding), [
        {col: 51, row: 11, state: {action: 'press', button: 'left', modifier: {control: false, shift: false, meta: false}}},
        {col: 51, row: 11, state: {action: 'release', button: '<none>', modifier: {control: false, shift: false, meta: false}}}
      ]);

      // test at max rows/cols
      await mouseMove(cols - 1, rows - 1);
      await mouseDown('left');
      await mouseUp('left');
      assert.deepEqual(await getReports(encoding), [
        {col: cols, row: rows, state: {action: 'press', button: 'left', modifier: {control: false, shift: false, meta: false}}},
        {col: cols, row: rows, state: {action: 'release', button: '<none>', modifier: {control: false, shift: false, meta: false}}}
      ]);

      // button press/move/release tests
      // left button
      await mouseMove(43, 24);
      await getReports(encoding); // clear reports
      await mouseDown('left');
      await mouseMove(44, 24);
      await mouseUp('left');
      assert.deepEqual(await getReports(encoding), [
        {col: 44, row: 25, state: {action: 'press', button: 'left', modifier: {control: false, shift: false, meta: false}}},
        {col: 45, row: 25, state: {action: 'move', button: 'left', modifier: {control: false, shift: false, meta: false}}},
        {col: 45, row: 25, state: {action: 'release', button: '<none>', modifier: {control: false, shift: false, meta: false}}}
      ]);
      // middle button
      // bug: default action not cancelled (adds data to getReports from clipboard under X11)
      // await mouseMove(43, 24);
      // await getReports(encoding); // clear reports
      // await mouseDown('middle');
      // await mouseMove(44, 24);
      // await mouseUp('middle');
      // assert.deepEqual(await getReports(encoding), [{col: 44, row: 25, state: {action: 'press', button: 'middle', modifier: {control: false, shift: false, meta: false}}}]);
      // right button
      // bug: default action not cancelled (popup shown)
      await mouseMove(43, 24);
      await getReports(encoding); // clear reports
      await mouseDown('right');
      await mouseMove(44, 24);
      await mouseUp('right');
      assert.deepEqual(await getReports(encoding), [
        {col: 44, row: 25, state: {action: 'press', button: 'right', modifier: {control: false, shift: false, meta: false}}},
        {col: 45, row: 25, state: {action: 'move', button: 'right', modifier: {control: false, shift: false, meta: false}}},
        {col: 45, row: 25, state: {action: 'release', button: '<none>', modifier: {control: false, shift: false, meta: false}}}
      ]);

      // wheel
      await mouseMove(43, 24);
      await getReports(encoding); // clear reports
      await wheelUp();
      assert.deepEqual(await getReports(encoding), [{col: 44, row: 25, state: {action: 'up', button: 'wheel', modifier: {control: false, shift: false, meta: false}}}]);
      await wheelDown();
      assert.deepEqual(await getReports(encoding), [{col: 44, row: 25, state: {action: 'down', button: 'wheel', modifier: {control: false, shift: false, meta: false}}}]);

      // modifiers
      // CTRL
      // bug: totally broken - reports no modifier, reports wrong button and action
      // after fix: removed faulty reports below and uncomment lines
      await mouseMove(43, 24);
      await getReports(encoding); // clear reports
      // await page.keyboard.down('Control');
      await mouseDown('left');
      await mouseMove(44, 24);
      await mouseUp('left');
      await wheelDown();
      // await page.keyboard.up('Control');
      assert.deepEqual(await getReports(encoding), [
        {col: 44, row: 25, state: {action: 'press', button: 'left', modifier: {control: false, shift: false, meta: false}}},
        {col: 45, row: 25, state: {action: 'move', button: 'left', modifier: {control: false, shift: false, meta: false}}},
        {col: 45, row: 25, state: {action: 'release', button: '<none>', modifier: {control: false, shift: false, meta: false}}},
        {col: 45, row: 25, state: {action: 'down', button: 'wheel', modifier: {control: false, shift: false, meta: false}}}
        // expected
        // {col: 44, row: 25, state: {action: 'press', button: 'left', modifier: {control: true, shift: false, meta: false}}},
        // {col: 45, row: 25, state: {action: 'move', button: 'left', modifier: {control: true, shift: false, meta: false}}},
        // {col: 45, row: 25, state: {action: 'release', button: '<none>', modifier: {control: true, shift: false, meta: false}}},
        // {col: 45, row: 25, state: {action: 'down', button: 'wheel', modifier: {control: true, shift: false, meta: false}}}
      ]);

      // ALT
      // bug: no modifier reported
      await mouseMove(43, 24);
      await getReports(encoding); // clear reports
      await page.keyboard.down('Alt');
      await mouseDown('left');
      await mouseMove(44, 24);
      await mouseUp('left');
      await wheelDown();
      await page.keyboard.up('Alt');
      assert.deepEqual(await getReports(encoding), [
        {col: 44, row: 25, state: {action: 'press', button: 'left', modifier: {control: false, shift: false, meta: false}}},
        {col: 45, row: 25, state: {action: 'move', button: 'left', modifier: {control: false, shift: false, meta: false}}},
        {col: 45, row: 25, state: {action: 'release', button: '<none>', modifier: {control: false, shift: false, meta: false}}},
        {col: 45, row: 25, state: {action: 'down', button: 'wheel', modifier: {control: false, shift: false, meta: false}}}
        // expected
        // {col: 44, row: 25, state: {action: 'press', button: 'left', modifier: {control: false, shift: false, meta: true}}},
        // {col: 45, row: 25, state: {action: 'move', button: 'left', modifier: {control: false, shift: false, meta: true}}},
        // {col: 45, row: 25, state: {action: 'release', button: '<none>', modifier: {control: false, shift: false, meta: true}}},
        // {col: 45, row: 25, state: {action: 'down', button: 'wheel', modifier: {control: false, shift: false, meta: true}}}
      ]);

      // SHIFT
      // note: press/release/drag caught by selection manager
      // bug: modifier not reported for passed events
      await mouseMove(43, 24);
      await getReports(encoding); // clear reports
      await page.keyboard.down('Shift');  // defaults to ShiftLeft
      await mouseDown('left');
      await mouseMove(44, 24);
      await mouseUp('left');
      await wheelDown();
      await page.keyboard.up('Shift');
      if (noShift) {
        assert.deepEqual(await getReports(encoding), [
          {col: 45, row: 25, state: {action: 'down', button: 'wheel', modifier: {control: false, shift: false, meta: false}}}
        ]);
      } else {
        // bug: completely messed up - wrong modifier, only partially reported
        assert.deepEqual(await getReports(encoding), [
          {col: 44, row: 25, state: {action: 'press', button: 'left', modifier: {control: true, shift: false, meta: false}}},
          {col: 45, row: 25, state: {action: 'move', button: 'left', modifier: {control: true, shift: false, meta: false}}},
          {col: 45, row: 25, state: {action: 'release', button: '<none>', modifier: {control: true, shift: false, meta: false}}},
          {col: 45, row: 25, state: {action: 'down', button: 'wheel', modifier: {control: false, shift: false, meta: false}}}
        ]);
      }

      /*
      // all modifiers
      // bug: this is totally broken with wrong coords and messed up modifiers
      await mouseMove(43, 24);
      await getReports(encoding); // clear reports
      await page.keyboard.down('Control');
      await page.keyboard.down('Alt');
      await page.keyboard.down('Shift');
      await mouseDown('left');
      await mouseMove(44, 24);
      await mouseUp('left');
      await wheelDown();
      await page.keyboard.up('Control');
      await page.keyboard.up('Alt');
      await page.keyboard.up('Shift');
      assert.deepEqual(await getReports(encoding), [
        {col: 44, row: 25, state: {action: 'press', button: 'left', modifier: {control: true, shift: true, meta: true}}},
        {col: 45, row: 25, state: {action: 'move', button: 'left', modifier: {control: true, shift: true, meta: true}}},
        {col: 45, row: 25, state: {action: 'release', button: '<none>', modifier: {control: true, shift: true, meta: true}}},
        {col: 45, row: 25, state: {action: 'down', button: 'wheel', modifier: {control: true, shift: true, meta: true}}}
      ]);
      */
    });
    it('SGR encoding', async () => {
      const encoding = 'SGR';
      await resetMouseModes();
      await mouseMove(0, 0);
      await page.evaluate(`window.term.write('\x1b[?1002h\x1b[?1006h');`);

      // test at 0,0
      // bug: release is fired immediately
      await mouseDown('left');
      assert.deepEqual(await getReports(encoding), [
        {col: 1, row: 1, state: {action: 'press', button: 'left', modifier: {control: false, shift: false, meta: false}}}
      ]);

      // mouseup should report, encoding cannot report released button
      await mouseUp('left');
      assert.deepEqual(await getReports(encoding), [
        {col: 1, row: 1, state: {action: 'release', button: 'left', modifier: {control: false, shift: false, meta: false}}}
      ]);

      // mousemove should not report
      await mouseMove(50, 10);
      assert.deepEqual(await getReports(encoding), []);
      await mouseDown('left');
      await mouseUp('left');
      assert.deepEqual(await getReports(encoding), [
        {col: 51, row: 11, state: {action: 'press', button: 'left', modifier: {control: false, shift: false, meta: false}}},
        {col: 51, row: 11, state: {action: 'release', button: 'left', modifier: {control: false, shift: false, meta: false}}}
      ]);

      // test at max rows/cols
      await mouseMove(cols - 1, rows - 1);
      await mouseDown('left');
      await mouseUp('left');
      assert.deepEqual(await getReports(encoding), [
        {col: cols, row: rows, state: {action: 'press', button: 'left', modifier: {control: false, shift: false, meta: false}}},
        {col: cols, row: rows, state: {action: 'release', button: 'left', modifier: {control: false, shift: false, meta: false}}}
      ]);

      // button press/move/release tests
      // left button
      await mouseMove(43, 24);
      await getReports(encoding); // clear reports
      await mouseDown('left');
      await mouseMove(44, 24);
      await mouseUp('left');
      assert.deepEqual(await getReports(encoding), [
        {col: 44, row: 25, state: {action: 'press', button: 'left', modifier: {control: false, shift: false, meta: false}}},
        {col: 45, row: 25, state: {action: 'move', button: 'left', modifier: {control: false, shift: false, meta: false}}},
        {col: 45, row: 25, state: {action: 'release', button: 'left', modifier: {control: false, shift: false, meta: false}}}
      ]);
      // middle button
      // bug: default action not cancelled (adds data to getReports from clipboard under X11)
      // await mouseMove(43, 24);
      // await getReports(encoding); // clear reports
      // await mouseDown('middle');
      // await mouseMove(44, 24);
      // await mouseUp('middle');
      // assert.deepEqual(await getReports(encoding), [{col: 44, row: 25, state: {action: 'press', button: 'middle', modifier: {control: false, shift: false, meta: false}}}]);
      // right button
      // bug: default action not cancelled (popup shown)
      // bug: release reports wrong button
      await mouseMove(43, 24);
      await getReports(encoding); // clear reports
      await mouseDown('right');
      await mouseMove(44, 24);
      await mouseUp('right');
      assert.deepEqual(await getReports(encoding), [
        {col: 44, row: 25, state: {action: 'press', button: 'right', modifier: {control: false, shift: false, meta: false}}},
        {col: 45, row: 25, state: {action: 'move', button: 'right', modifier: {control: false, shift: false, meta: false}}},
        {col: 45, row: 25, state: {action: 'release', button: 'left', modifier: {control: false, shift: false, meta: false}}}
      ]);

      // wheel
      await mouseMove(43, 24);
      await getReports(encoding); // clear reports
      await wheelUp();
      assert.deepEqual(await getReports(encoding), [{col: 44, row: 25, state: {action: 'up', button: 'wheel', modifier: {control: false, shift: false, meta: false}}}]);
      await wheelDown();
      assert.deepEqual(await getReports(encoding), [{col: 44, row: 25, state: {action: 'down', button: 'wheel', modifier: {control: false, shift: false, meta: false}}}]);

      // modifiers
      // CTRL
      // bug: totally broken - reports no modifier, reports wrong button and action
      // after fix: removed faulty reports below and uncomment lines
      await mouseMove(43, 24);
      await getReports(encoding); // clear reports
      // await page.keyboard.down('Control');
      await mouseDown('left');
      await mouseMove(44, 24);
      await mouseUp('left');
      await wheelDown();
      // await page.keyboard.up('Control');
      assert.deepEqual(await getReports(encoding), [
        {col: 44, row: 25, state: {action: 'press', button: 'left', modifier: {control: false, shift: false, meta: false}}},
        {col: 45, row: 25, state: {action: 'move', button: 'left', modifier: {control: false, shift: false, meta: false}}},
        {col: 45, row: 25, state: {action: 'release', button: 'left', modifier: {control: false, shift: false, meta: false}}},
        {col: 45, row: 25, state: {action: 'down', button: 'wheel', modifier: {control: false, shift: false, meta: false}}}
        // expected
        // {col: 44, row: 25, state: {action: 'press', button: 'left', modifier: {control: true, shift: false, meta: false}}},
        // {col: 45, row: 25, state: {action: 'move', button: 'left', modifier: {control: true, shift: false, meta: false}}},
        // {col: 45, row: 25, state: {action: 'release', button: 'left', modifier: {control: true, shift: false, meta: false}}},
        // {col: 45, row: 25, state: {action: 'down', button: 'wheel', modifier: {control: true, shift: false, meta: false}}}
      ]);

      // ALT
      // bug: no modifier reported
      await mouseMove(43, 24);
      await getReports(encoding); // clear reports
      await page.keyboard.down('Alt');
      await mouseDown('left');
      await mouseMove(44, 24);
      await mouseUp('left');
      await wheelDown();
      await page.keyboard.up('Alt');
      assert.deepEqual(await getReports(encoding), [
        {col: 44, row: 25, state: {action: 'press', button: 'left', modifier: {control: false, shift: false, meta: false}}},
        {col: 45, row: 25, state: {action: 'move', button: 'left', modifier: {control: false, shift: false, meta: false}}},
        {col: 45, row: 25, state: {action: 'release', button: 'left', modifier: {control: false, shift: false, meta: false}}},
        {col: 45, row: 25, state: {action: 'down', button: 'wheel', modifier: {control: false, shift: false, meta: false}}}
        // expected
        // {col: 44, row: 25, state: {action: 'press', button: 'left', modifier: {control: false, shift: false, meta: true}}},
        // {col: 45, row: 25, state: {action: 'move', button: 'left', modifier: {control: false, shift: false, meta: true}}},
        // {col: 45, row: 25, state: {action: 'release', button: 'left', modifier: {control: false, shift: false, meta: true}}},
        // {col: 45, row: 25, state: {action: 'down', button: 'wheel', modifier: {control: false, shift: false, meta: true}}}
      ]);

      // SHIFT
      // note: press/release/drag caught by selection manager
      // bug: modifier not reported for passed events
      await mouseMove(43, 24);
      await getReports(encoding); // clear reports
      await page.keyboard.down('Shift');  // defaults to ShiftLeft
      await mouseDown('left');
      await mouseMove(44, 24);
      await mouseUp('left');
      await wheelDown();
      await page.keyboard.up('Shift');
      if (noShift) {
        assert.deepEqual(await getReports(encoding), [
          {col: 45, row: 25, state: {action: 'down', button: 'wheel', modifier: {control: false, shift: false, meta: false}}}
        ]);
      } else {
        // bug: completely messed up - wrong modifier, only partially reported
        assert.deepEqual(await getReports(encoding), [
          {col: 44, row: 25, state: {action: 'press', button: 'left', modifier: {control: true, shift: false, meta: false}}},
          {col: 45, row: 25, state: {action: 'move', button: 'left', modifier: {control: true, shift: false, meta: false}}},
          {col: 45, row: 25, state: {action: 'release', button: 'left', modifier: {control: true, shift: false, meta: false}}},
          {col: 45, row: 25, state: {action: 'down', button: 'wheel', modifier: {control: false, shift: false, meta: false}}}
        ]);
      }

      /*
      // all modifiers
      // bug: this is totally broken with wrong coords and messed up modifiers
      await mouseMove(43, 24);
      await getReports(encoding); // clear reports
      await page.keyboard.down('Control');
      await page.keyboard.down('Alt');
      await page.keyboard.down('Shift');
      await mouseDown('left');
      await mouseMove(44, 24);
      await mouseUp('left');
      await wheelDown();
      await page.keyboard.up('Control');
      await page.keyboard.up('Alt');
      await page.keyboard.up('Shift');
      assert.deepEqual(await getReports(encoding), [
        {col: 44, row: 25, state: {action: 'press', button: 'left', modifier: {control: true, shift: true, meta: true}}},
        {col: 45, row: 25, state: {action: 'move', button: 'left', modifier: {control: true, shift: true, meta: true}}},
        {col: 45, row: 25, state: {action: 'release', button: 'left', modifier: {control: true, shift: true, meta: true}}},
        {col: 45, row: 25, state: {action: 'down', button: 'wheel', modifier: {control: true, shift: true, meta: true}}}
      ]);
      */
    });
    it('URXVT encoding', async () => {
      const encoding = 'URXVT';
      await resetMouseModes();
      await mouseMove(0, 0);
      await page.evaluate(`window.term.write('\x1b[?1002h\x1b[?1015h');`);

      // test at 0,0
      // bug: release is fired immediately
      await mouseDown('left');
      assert.deepEqual(await getReports(encoding), [
        {col: 1, row: 1, state: {action: 'press', button: 'left', modifier: {control: false, shift: false, meta: false}}}
      ]);

      // mouseup should report, encoding cannot report released button
      await mouseUp('left');
      assert.deepEqual(await getReports(encoding), [
        {col: 1, row: 1, state: {action: 'release', button: '<none>', modifier: {control: false, shift: false, meta: false}}}
      ]);

      // mousemove should not report
      await mouseMove(50, 10);
      assert.deepEqual(await getReports(encoding), []);
      await mouseDown('left');
      await mouseUp('left');
      assert.deepEqual(await getReports(encoding), [
        {col: 51, row: 11, state: {action: 'press', button: 'left', modifier: {control: false, shift: false, meta: false}}},
        {col: 51, row: 11, state: {action: 'release', button: '<none>', modifier: {control: false, shift: false, meta: false}}}
      ]);

      // test at max rows/cols
      await mouseMove(cols - 1, rows - 1);
      await mouseDown('left');
      await mouseUp('left');
      assert.deepEqual(await getReports(encoding), [
        {col: cols, row: rows, state: {action: 'press', button: 'left', modifier: {control: false, shift: false, meta: false}}},
        {col: cols, row: rows, state: {action: 'release', button: '<none>', modifier: {control: false, shift: false, meta: false}}}
      ]);

      // button press/move/release tests
      // left button
      await mouseMove(43, 24);
      await getReports(encoding); // clear reports
      await mouseDown('left');
      await mouseMove(44, 24);
      await mouseUp('left');
      assert.deepEqual(await getReports(encoding), [
        {col: 44, row: 25, state: {action: 'press', button: 'left', modifier: {control: false, shift: false, meta: false}}},
        {col: 45, row: 25, state: {action: 'move', button: 'left', modifier: {control: false, shift: false, meta: false}}},
        {col: 45, row: 25, state: {action: 'release', button: '<none>', modifier: {control: false, shift: false, meta: false}}}
      ]);
      // middle button
      // bug: default action not cancelled (adds data to getReports from clipboard under X11)
      // await mouseMove(43, 24);
      // await getReports(encoding); // clear reports
      // await mouseDown('middle');
      // await mouseMove(44, 24);
      // await mouseUp('middle');
      // assert.deepEqual(await getReports(encoding), [{col: 44, row: 25, state: {action: 'press', button: 'middle', modifier: {control: false, shift: false, meta: false}}}]);
      // right button
      // bug: default action not cancelled (popup shown)
      await mouseMove(43, 24);
      await getReports(encoding); // clear reports
      await mouseDown('right');
      await mouseMove(44, 24);
      await mouseUp('right');
      assert.deepEqual(await getReports(encoding), [
        {col: 44, row: 25, state: {action: 'press', button: 'right', modifier: {control: false, shift: false, meta: false}}},
        {col: 45, row: 25, state: {action: 'move', button: 'right', modifier: {control: false, shift: false, meta: false}}},
        {col: 45, row: 25, state: {action: 'release', button: '<none>', modifier: {control: false, shift: false, meta: false}}}
      ]);

      // wheel
      await mouseMove(43, 24);
      await getReports(encoding); // clear reports
      await wheelUp();
      assert.deepEqual(await getReports(encoding), [{col: 44, row: 25, state: {action: 'up', button: 'wheel', modifier: {control: false, shift: false, meta: false}}}]);
      await wheelDown();
      assert.deepEqual(await getReports(encoding), [{col: 44, row: 25, state: {action: 'down', button: 'wheel', modifier: {control: false, shift: false, meta: false}}}]);

      // modifiers
      // CTRL
      // bug: totally broken - reports no modifier, reports wrong button and action
      // after fix: removed faulty reports below and uncomment lines
      await mouseMove(43, 24);
      await getReports(encoding); // clear reports
      // await page.keyboard.down('Control');
      await mouseDown('left');
      await mouseMove(44, 24);
      await mouseUp('left');
      await wheelDown();
      // await page.keyboard.up('Control');
      assert.deepEqual(await getReports(encoding), [
        {col: 44, row: 25, state: {action: 'press', button: 'left', modifier: {control: false, shift: false, meta: false}}},
        {col: 45, row: 25, state: {action: 'move', button: 'left', modifier: {control: false, shift: false, meta: false}}},
        {col: 45, row: 25, state: {action: 'release', button: '<none>', modifier: {control: false, shift: false, meta: false}}},
        {col: 45, row: 25, state: {action: 'down', button: 'wheel', modifier: {control: false, shift: false, meta: false}}}
        // expected
        // {col: 44, row: 25, state: {action: 'press', button: 'left', modifier: {control: true, shift: false, meta: false}}},
        // {col: 45, row: 25, state: {action: 'move', button: 'left', modifier: {control: true, shift: false, meta: false}}},
        // {col: 45, row: 25, state: {action: 'release', button: '<none>', modifier: {control: true, shift: false, meta: false}}},
        // {col: 45, row: 25, state: {action: 'down', button: 'wheel', modifier: {control: true, shift: false, meta: false}}}
      ]);

      // ALT
      // bug: no modifier reported
      await mouseMove(43, 24);
      await getReports(encoding); // clear reports
      await page.keyboard.down('Alt');
      await mouseDown('left');
      await mouseMove(44, 24);
      await mouseUp('left');
      await wheelDown();
      await page.keyboard.up('Alt');
      assert.deepEqual(await getReports(encoding), [
        {col: 44, row: 25, state: {action: 'press', button: 'left', modifier: {control: false, shift: false, meta: false}}},
        {col: 45, row: 25, state: {action: 'move', button: 'left', modifier: {control: false, shift: false, meta: false}}},
        {col: 45, row: 25, state: {action: 'release', button: '<none>', modifier: {control: false, shift: false, meta: false}}},
        {col: 45, row: 25, state: {action: 'down', button: 'wheel', modifier: {control: false, shift: false, meta: false}}}
        // expected
        // {col: 44, row: 25, state: {action: 'press', button: 'left', modifier: {control: false, shift: false, meta: true}}},
        // {col: 45, row: 25, state: {action: 'move', button: 'left', modifier: {control: false, shift: false, meta: true}}},
        // {col: 45, row: 25, state: {action: 'release', button: '<none>', modifier: {control: false, shift: false, meta: true}}},
        // {col: 45, row: 25, state: {action: 'down', button: 'wheel', modifier: {control: false, shift: false, meta: true}}}
      ]);

      // SHIFT
      // note: press/release/drag caught by selection manager
      // bug: modifier not reported for passed events
      await mouseMove(43, 24);
      await getReports(encoding); // clear reports
      await page.keyboard.down('Shift');  // defaults to ShiftLeft
      await mouseDown('left');
      await mouseMove(44, 24);
      await mouseUp('left');
      await wheelDown();
      await page.keyboard.up('Shift');
      if (noShift) {
        assert.deepEqual(await getReports(encoding), [
          {col: 45, row: 25, state: {action: 'down', button: 'wheel', modifier: {control: false, shift: false, meta: false}}}
        ]);
      } else {
        // bug: completely messed up - wrong modifier, only partially reported
        assert.deepEqual(await getReports(encoding), [
          {col: 44, row: 25, state: {action: 'press', button: 'left', modifier: {control: true, shift: false, meta: false}}},
          {col: 45, row: 25, state: {action: 'move', button: 'left', modifier: {control: true, shift: false, meta: false}}},
          {col: 45, row: 25, state: {action: 'release', button: '<none>', modifier: {control: true, shift: false, meta: false}}},
          {col: 45, row: 25, state: {action: 'down', button: 'wheel', modifier: {control: false, shift: false, meta: false}}}
        ]);
      }

      /*
      // all modifiers
      // bug: this is totally broken with wrong coords and messed up modifiers
      await mouseMove(43, 24);
      await getReports(encoding); // clear reports
      await page.keyboard.down('Control');
      await page.keyboard.down('Alt');
      await page.keyboard.down('Shift');
      await mouseDown('left');
      await mouseMove(44, 24);
      await mouseUp('left');
      await wheelDown();
      await page.keyboard.up('Control');
      await page.keyboard.up('Alt');
      await page.keyboard.up('Shift');
      assert.deepEqual(await getReports(encoding), [
        {col: 44, row: 25, state: {action: 'press', button: 'left', modifier: {control: true, shift: true, meta: true}}},
        {col: 45, row: 25, state: {action: 'move', button: 'left', modifier: {control: true, shift: true, meta: true}}},
        {col: 45, row: 25, state: {action: 'release', button: '<none>', modifier: {control: true, shift: true, meta: true}}},
        {col: 45, row: 25, state: {action: 'down', button: 'wheel', modifier: {control: true, shift: true, meta: true}}}
      ]);
      */
    });
  });
  describe('DECSET 1003 (xterm any event)', () => {
    /**
     * VT200 protocol:
     *  - all events (press, release, wheel, move)
     *  - all modifiers
     */
    // bug: currently same reports as 1002, FIXME: implement tests once fixed
  });
  // TODO: move tests with several buttons pressed
});
