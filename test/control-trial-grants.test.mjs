import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {TRIAL_CREDITS_PER_ACCOUNT, trialCredits} from '../src/billing/trial.mjs';
import {Ledger} from '../src/billing/ledger.mjs';
import {ControlIdentity} from '../src/control-identity.mjs';
import {Store} from '../src/store.mjs';

const settings = () => ({projects: {}, controlPlane: {enabled: true, bridgeSecret: 'fixture-private-bridge-secret-not-real', creditPolicy: {}}});

test('the trial defaults to 1,000 credits and cannot be raised above it', () => {
  const config = settings();
  assert.equal(trialCredits(config), TRIAL_CREDITS_PER_ACCOUNT);
  config.controlPlane.creditPolicy.trialCredits = 25;
  assert.equal(trialCredits(config), 25);
  config.controlPlane.creditPolicy.trialCredits = 1001;
  assert.throws(() => trialCredits(config), {code: 'credit_policy_invalid'});
});

test('one lifetime trial per verified user, whatever projects they create or delete', {skip: !process.env.TEST_DATABASE_URL}, async t => {
  assert.match(new URL(process.env.TEST_DATABASE_URL).pathname, /^\/gateway_test_[A-Za-z0-9_]+$/);
  const store = new Store(process.env.TEST_DATABASE_URL);
  const config = settings();
  const identity = new ControlIdentity({store, config});
  const ledger = new Ledger({store, config});
  const users = [];
  const projects = [];
  const trial = async project => (await ledger.balance(project)).trial;
  const makeUser = async () => {
    const id = randomUUID();
    users.push(id);
    await store.pool.query('INSERT INTO control_users (id, email) VALUES ($1, $2)', [id, `trial-${id}@example.test`]);
    return id;
  };
  const create = async (user, name) => {
    const project = await identity.createProject(user, {name});
    projects.push(project.id);
    return project.id;
  };
  const dropProject = async project => {
    await store.pool.query('DELETE FROM control_memberships WHERE project = $1', [project]);
    await store.pool.query('DELETE FROM control_credit_accounts WHERE project = $1', [project]);
    await store.pool.query('DELETE FROM control_projects WHERE id = $1', [project]);
  };
  t.after(async () => {
    await store.pool.query('DELETE FROM control_memberships WHERE project = ANY($1)', [projects]);
    await store.pool.query('DELETE FROM control_credit_accounts WHERE project = ANY($1)', [projects]);
    await store.pool.query('DELETE FROM control_projects WHERE id = ANY($1)', [projects]);
    await store.pool.query('DELETE FROM control_users WHERE id = ANY($1)', [users]);
    await store.close();
  });
  await store.init();

  await t.test('parallel first projects and recreation cannot duplicate the trial', async () => {
    const user = await makeUser();
    const first = await Promise.all([create(user, 'First request'), create(user, 'Second request')]);
    assert.deepEqual((await Promise.all(first.map(trial))).sort((a, b) => a - b), [0, 1000]);
    for (const id of first) await dropProject(id);
    const next = await create(user, 'Replacement project');
    assert.equal(await trial(next), 0);
    const receipts = (await store.pool.query('SELECT project, granted_credits FROM control_trial_grant_receipts WHERE user_id = $1', [user])).rows;
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].granted_credits, '1000');
  });

  await t.test('a smaller earlier trial is topped up to the current size only once', async () => {
    const user = await makeUser();
    config.controlPlane.creditPolicy.trialCredits = 25;
    const old = await create(user, 'Prior offer');
    assert.equal(await trial(old), 25);
    await dropProject(old);
    config.controlPlane.creditPolicy.trialCredits = 1000;
    const next = await create(user, 'After trial upgrade');
    assert.equal(await trial(next), 975);
    assert.equal(await trial(await create(user, 'No extra trial')), 0);
  });

  await t.test('a user who never had a trial gets it on first authenticated use', async () => {
    const user = await makeUser();
    const project = 'cp_' + randomUUID();
    projects.push(project);
    await store.pool.query('INSERT INTO control_projects (id, user_id, name) VALUES ($1, $2, $3)', [project, user, 'Old project']);
    await store.pool.query('INSERT INTO control_credit_accounts (project, granted_credits) VALUES ($1, 0)', [project]);
    await Promise.all([identity.hydrateProject(project), identity.hydrateProject(project)]);
    assert.equal(await trial(project), 1000);
  });
});
