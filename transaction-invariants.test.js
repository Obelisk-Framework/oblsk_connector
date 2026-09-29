const test = require('node:test');
const assert = require('node:assert/strict');
const { assertExpectedAffectedRows } = require('./transaction-invariants');

test('queries without an affected-row invariant pass through', () => {
    assert.doesNotThrow(() => assertExpectedAffectedRows({ query: 'SELECT 1' }, undefined));
});

test('matching affected-row count passes', () => {
    assert.doesNotThrow(() => assertExpectedAffectedRows({ expectedAffectedRows: 1 }, 1));
});

test('mismatched affected-row count aborts the transaction', () => {
    assert.throws(() => assertExpectedAffectedRows({ expectedAffectedRows: 1 }, 0), /expected 1 affected row/);
});

test('invalid affected-row expectation is rejected', () => {
    assert.throws(() => assertExpectedAffectedRows({ expectedAffectedRows: 0.5 }, 0));
});
