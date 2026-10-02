const { test } = require('node:test');
const assert = require('node:assert/strict');
const { moveToSlotOf, paneAtPoint } = require('../src/terminalReorder.ts');

test('moving forward takes the target slot and shifts the rest back', () => {
  assert.deepEqual(moveToSlotOf(['a', 'b', 'c', 'd'], 'a', 'c'), ['b', 'c', 'a', 'd']);
});

test('moving backward places the pane before the target', () => {
  assert.deepEqual(moveToSlotOf(['a', 'b', 'c', 'd'], 'd', 'b'), ['a', 'd', 'b', 'c']);
});

test('unknown ids and self-moves leave the order alone', () => {
  const ids = ['a', 'b'];
  assert.equal(moveToSlotOf(ids, 'a', 'a'), ids);
  assert.equal(moveToSlotOf(ids, 'a', 'z'), ids);
});

test('pane hit testing ignores the dragged pane and gaps', () => {
  const boxes = [
    { id: 'a', left: 0, top: 0, width: 100, height: 100 },
    { id: 'b', left: 110, top: 0, width: 100, height: 100 },
  ];
  assert.equal(paneAtPoint(boxes, 150, 50, 'a'), 'b');
  assert.equal(paneAtPoint(boxes, 50, 50, 'a'), null);
  assert.equal(paneAtPoint(boxes, 105, 50, 'a'), null);
});
