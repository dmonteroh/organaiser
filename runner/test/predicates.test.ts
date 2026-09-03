import { test } from 'node:test';
import assert from 'node:assert/strict';

import { accept, type Facts } from '../src/engine/predicates.ts';

test('declared mode additionally requires claims-parity true', () => {
  const base: Omit<Facts, 'verification'> = {
    verificationMode: 'declared',
    frontmatterStatus: 'Done',
    integrationCommit: 'abc1234',
    integrationCommitExists: true,
    integrationCommitIsAncestor: true,
    implementerCommits: ['def5678'],
    implementerCommitsAllExist: true,
    reuseLanded: false,
    specReviewer: { verdict: 'pass', reportExists: true, reportPassLine: true },
    qualityReviewer: { verdict: 'pass', reportExists: true, reportPassLine: true },
  };

  const parityFalse = accept({ ...base, verification: { status: 'pass', claimsParity: false } });
  assert.equal(parityFalse.state, 'incomplete');
  assert.ok(parityFalse.gaps.includes('verification:claimsParity'));

  const parityTrue = accept({ ...base, verification: { status: 'pass', claimsParity: true } });
  assert.equal(parityTrue.state, 'accepted');
});

// ── Synthetic genuinely-incomplete fixture → incomplete + non-empty gaps ──────
test('synthetic incomplete task (missing quality-reviewer, status not Done) -> incomplete', () => {
  const facts: Facts = {
    verificationMode: 'legacy',
    frontmatterStatus: 'In Progress', // not Done
    integrationCommit: null, // no integration commit
    integrationCommitExists: false,
    integrationCommitIsAncestor: false,
    implementerCommits: [], // no implementer commits
    implementerCommitsAllExist: true,
    reuseLanded: false,
    specReviewer: { verdict: 'pass', reportExists: true, reportPassLine: true },
    qualityReviewer: null, // missing entirely
    verification: { status: 'pass' },
  };
  const result = accept(facts);
  assert.equal(result.state, 'incomplete');
  assert.ok(result.gaps.length > 0, 'gap set must be non-empty');
  assert.ok(result.gaps.includes('status'));
  assert.ok(result.gaps.includes('integrationCommit:missing'));
  assert.ok(result.gaps.includes('implementerCommits:empty'));
  assert.ok(result.gaps.includes('qualityReviewer:missing'));
});

// ── Gap-set precision: each invalid conjunct yields its own gap token ─────────
test('individual conjunct failures produce precise gap tokens', () => {
  const good: Facts = {
    verificationMode: 'legacy',
    frontmatterStatus: 'Done',
    integrationCommit: 'abc1234',
    integrationCommitExists: true,
    integrationCommitIsAncestor: true,
    implementerCommits: ['def5678'],
    implementerCommitsAllExist: true,
    reuseLanded: false,
    specReviewer: { verdict: 'pass', reportExists: true, reportPassLine: true },
    qualityReviewer: { verdict: 'pass', reportExists: true, reportPassLine: true },
    verification: { status: 'pass' },
  };
  assert.deepEqual(accept(good).gaps, []);

  // integration commit present in ledger but not an ancestor of HEAD.
  assert.deepEqual(
    accept({ ...good, integrationCommitIsAncestor: false }).gaps,
    ['integrationCommit:notAncestor'],
  );

  // implementer commit recorded but absent from git.
  assert.deepEqual(
    accept({ ...good, implementerCommitsAllExist: false }).gaps,
    ['implementerCommits:missingInRepo'],
  );

  // reviewer verdict says pass but the re-opened report carries no pass line:
  // re-checked, not trusted.
  assert.deepEqual(
    accept({ ...good, specReviewer: { verdict: 'pass', reportExists: true, reportPassLine: false } }).gaps,
    ['specReviewer:reportPassLine'],
  );

  // verification status not pass.
  assert.deepEqual(
    accept({ ...good, verification: { status: 'fail' } }).gaps,
    ['verification:status'],
  );
});

// ── Verified no-op reuse waives implementerCommits:empty ──────────────────────
//
// When the orchestrator re-enters an already-Done task it dispatches no workers, so
// the reuse path accretes ZERO implementer commits, yet the work already landed
// (integration commit is an ancestor of HEAD, spec is Done). reuseLanded lets accept()
// waive implementerCommits:empty so a genuine reuse is accepted instead of looping
// forever; without it the loop burns every attempt on an already-finished task.
test('verified no-op reuse (reuseLanded) waives implementerCommits:empty', () => {
  const reuse: Facts = {
    verificationMode: 'legacy',
    frontmatterStatus: 'Done',
    integrationCommit: '5129dac',
    integrationCommitExists: true,
    integrationCommitIsAncestor: true,
    implementerCommits: [], // reuse path dispatched nobody → empty
    implementerCommitsAllExist: true,
    reuseLanded: true,
    specReviewer: { verdict: 'pass', reportExists: true, reportPassLine: true },
    qualityReviewer: { verdict: 'pass', reportExists: true, reportPassLine: true },
    verification: { status: 'pass' },
  };
  const result = accept(reuse);
  assert.equal(result.state, 'accepted', `expected accepted; gaps: ${JSON.stringify(result.gaps)}`);
  assert.ok(!result.gaps.includes('implementerCommits:empty'));

  // The waiver is SCOPED to the empty case: a reuse that somehow recorded a commit
  // missing from the repo must still fail: reuseLanded never masks a real defect.
  const reuseMissing = accept({
    ...reuse,
    implementerCommits: ['deadbee'],
    implementerCommitsAllExist: false,
  });
  assert.deepEqual(reuseMissing.gaps, ['implementerCommits:missingInRepo']);

  // Regression guard: WITHOUT reuseLanded, an empty implementer-commit set still gaps.
  const notReuse = accept({ ...reuse, reuseLanded: false });
  assert.ok(notReuse.gaps.includes('implementerCommits:empty'));
});
