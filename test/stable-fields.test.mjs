// The changelog's promise (docs/changelog.json policy.compatibility): no
// breaking change to a documented answer field without a deprecation first.
// docs/stable-fields.json pins the fields callers told us they read; a change
// that breaks one fails here unless the changelog deprecates that field.
import assert from 'node:assert/strict';
import test from 'node:test';
import spec from '../docs/openapi.json' with {type: 'json'};
import changelog from '../docs/changelog.json' with {type: 'json'};
import pins from '../docs/stable-fields.json' with {type: 'json'};
import {breaks, shapeOf} from '../scripts/stable-fields.mjs';

const day = value => Date.parse(`${value}T00:00:00Z`);

test('no pinned field breaks without a deprecation that gives the policy\'s notice', () => {
  assert.ok(Object.keys(pins.fields).length > 0);
  for (const [field, pinned] of Object.entries(pins.fields)) {
    const problems = breaks(pinned, shapeOf(spec, field));
    if (!problems.length) continue;
    const deprecation = changelog.deprecations.find(entry => entry.field === field);
    assert.ok(deprecation, `${field}: ${problems.join('; ')}. That breaks callers who read it: deprecate it in docs/changelog.json first (an entry with field, deprecated_in, deprecated_on, sunset_on at least ${changelog.policy.notice_days} days later, replacement), ship that, and change it after the sunset.`);
    assert.ok(Date.now() >= day(deprecation.sunset_on), `${field} changes before its sunset (${deprecation.sunset_on})`);
  }
});

test('the changelog states the compatibility promise these pins hold', () => {
  assert.equal(changelog.policy.notice_days, 30);
  assert.match(changelog.policy.compatibility, /at least 30 days/);
  // Pins are written as the contract has them: Schema.path, [] for an array's items.
  for (const field of Object.keys(pins.fields)) assert.match(field, /^[A-Z][A-Za-z]+(?:\.[a-z_]+(?:\[\])?)+$/, field);
});

const synthetic = {components: {schemas: {
  Result: {type: 'object', required: ['state', 'steps', 'error'], properties: {
    state: {type: 'string', enum: ['a', 'b']},
    steps: {type: 'array', items: {$ref: '#/components/schemas/Step'}},
    error: {oneOf: [{$ref: '#/components/schemas/Problem'}, {type: 'null'}]},
  }},
  Step: {type: 'object', required: ['kind'], properties: {kind: {type: 'string'}, ms: {type: 'integer'}}},
  Problem: {type: 'object', required: ['code'], properties: {code: {type: 'string', enum: ['x', 'y']}}},
}}};
const variant = change => { const copy = structuredClone(synthetic); change(copy.components.schemas); return copy; };

test('shapes follow refs, arrays and nullable branches', () => {
  assert.deepEqual(shapeOf(synthetic, 'Result.state'), {types: ['string'], enum: ['a', 'b'], required: true});
  assert.deepEqual(shapeOf(synthetic, 'Result.steps[].kind'), {types: ['string'], required: true});
  assert.deepEqual(shapeOf(synthetic, 'Result.steps[].ms'), {types: ['integer'], required: false});
  assert.deepEqual(shapeOf(synthetic, 'Result.error'), {types: ['null', 'object'], required: true});
  assert.deepEqual(shapeOf(synthetic, 'Result.error.code'), {types: ['string'], enum: ['x', 'y'], required: true});
  assert.equal(shapeOf(synthetic, 'Result.gone'), null);
  assert.equal(shapeOf(synthetic, 'Result.state[].x'), null);
});

test('removals, new types, dropped values and lost presence break; additions do not', () => {
  const pinned = field => shapeOf(synthetic, field);
  const check = (field, change) => breaks(pinned(field), shapeOf(variant(change), field));
  assert.deepEqual(check('Result.state', schemas => { schemas.Result.properties.state.enum.push('c'); schemas.Result.properties.extra = {type: 'string'}; }), []);
  assert.deepEqual(check('Result.steps[].kind', schemas => { delete schemas.Step.properties.kind; }), ['it is gone (removed or renamed)']);
  assert.deepEqual(check('Result.state', schemas => { schemas.Result.properties.state.type = ['string', 'null']; }), ['it may now be null']);
  assert.deepEqual(check('Result.state', schemas => { schemas.Result.properties.state.enum = ['a']; }), ['values b are gone']);
  assert.deepEqual(check('Result.error.code', schemas => { delete schemas.Problem.properties.code.enum; }), ['it lost its list of values']);
  assert.deepEqual(check('Result.steps[].kind', schemas => { schemas.Step.required = []; }), ['it is no longer always present']);
  assert.deepEqual(check('Result.steps[].ms', schemas => { schemas.Step.properties.ms.type = 'number'; }), ['it may now be number']);
  assert.deepEqual(check('Result.state', schemas => { schemas.Result.properties.state = {type: 'string', enum: ['a', 'b'], description: 'reworded'}; }), []);
});
