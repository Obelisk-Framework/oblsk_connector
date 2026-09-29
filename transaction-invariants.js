function assertExpectedAffectedRows(item, affectedRows) {
    if (!item || typeof item !== 'object' || item.expectedAffectedRows === undefined) return;
    const expected = item.expectedAffectedRows;
    if (!Number.isSafeInteger(expected) || expected < 0) {
        throw new Error('Invalid expectedAffectedRows transaction invariant');
    }
    if (affectedRows !== expected) {
        throw new Error(`Transaction invariant failed: expected ${expected} affected row(s), got ${affectedRows}`);
    }
}

module.exports = { assertExpectedAffectedRows };
