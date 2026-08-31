import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  applyAnswer,
  mergeLines,
  nextQuestion,
  toCartLines,
  type ItemRequirements,
  type PendingLine,
} from '@/services/whatsapp_helpers/cart_state';

/**
 * A WhatsApp catalog cart arrives with no variant and no modifiers, so this
 * logic decides everything the bot asks. Getting it wrong means either an
 * unanswerable question or an order priced without a choice the customer
 * never made.
 */

const jollof: ItemRequirements = {
  menuItemId: 'item_jollof',
  name: 'Jollof Rice',
  variants: [
    { id: 'var_reg', name: 'Regular', priceMinor: 5000 },
    { id: 'var_lg', name: 'Large', priceMinor: 7500 },
  ],
  groups: [
    {
      id: 'grp_protein',
      name: 'Choose your protein',
      minSelect: 1,
      maxSelect: 1,
      modifiers: [
        { id: 'mod_chicken', name: 'Chicken', priceMinor: 2500 },
        { id: 'mod_fish', name: 'Fish', priceMinor: 3500 },
      ],
    },
    {
      id: 'grp_extras',
      name: 'Extras',
      minSelect: 0,
      maxSelect: 2,
      modifiers: [
        { id: 'mod_plantain', name: 'Plantain', priceMinor: 1500 },
        { id: 'mod_egg', name: 'Egg', priceMinor: 1000 },
      ],
    },
  ],
};

const water: ItemRequirements = {
  menuItemId: 'item_water',
  name: 'Bottled Water',
  variants: [],
  groups: [],
};

const requirements = new Map([
  [jollof.menuItemId, jollof],
  [water.menuItemId, water],
]);

const line = (menuItemId: string, over: Partial<PendingLine> = {}): PendingLine => ({
  menuItemId,
  quantity: 1,
  modifierIds: [],
  ...over,
});

describe('cart state', () => {
  it('asks nothing about an item that needs nothing', () => {
    assert.equal(nextQuestion([line('item_water')], requirements), null);
  });

  it('asks for the variant before any modifier group', () => {
    const question = nextQuestion([line('item_jollof')], requirements);
    assert.equal(question?.kind, 'variant');
    assert.equal(question?.lineIndex, 0);
  });

  it('asks for a required group once the variant is settled', () => {
    const question = nextQuestion([line('item_jollof', { variantId: 'var_lg' })], requirements);
    assert.equal(question?.kind, 'group');
    assert.equal(question?.kind === 'group' ? question.group.id : null, 'grp_protein');
  });

  it('never asks about an optional group', () => {
    const answered = line('item_jollof', { variantId: 'var_lg', modifierIds: ['mod_fish'] });
    assert.equal(nextQuestion([answered], requirements), null);
  });

  it('finishes one item before starting the next', () => {
    const lines = [line('item_water'), line('item_jollof')];
    const question = nextQuestion(lines, requirements);
    assert.equal(question?.lineIndex, 1, 'should skip the item that needs nothing');
  });

  it('ignores an item that is no longer on the menu rather than looping', () => {
    // A line whose requirements cannot be looked up would otherwise be asked
    // about forever, since no answer could ever satisfy it.
    assert.equal(nextQuestion([line('item_gone')], requirements), null);
  });

  it('records a variant answer against the right line only', () => {
    const lines = [line('item_jollof'), line('item_jollof')];
    const question = nextQuestion(lines, requirements);
    assert.ok(question);

    const updated = applyAnswer(lines, question, 'var_lg');
    assert.equal(updated[0]?.variantId, 'var_lg');
    assert.equal(updated[1]?.variantId, undefined);
    // The input must not have been mutated.
    assert.equal(lines[0]?.variantId, undefined);
  });

  it('replaces rather than accumulates in a single-select group', () => {
    let lines = [line('item_jollof', { variantId: 'var_lg' })];
    const question = nextQuestion(lines, requirements);
    assert.ok(question);

    lines = applyAnswer(lines, question, 'mod_chicken');
    lines = applyAnswer(lines, question, 'mod_fish');

    assert.deepEqual(lines[0]?.modifierIds, ['mod_fish'], 'a second tap corrects the first');
  });

  it('walks a whole item to completion', () => {
    let lines = [line('item_jollof')];
    const answers = ['var_lg', 'mod_fish'];

    for (const answer of answers) {
      const question = nextQuestion(lines, requirements);
      assert.ok(question, `expected a question before answering ${answer}`);
      lines = applyAnswer(lines, question, answer);
    }

    assert.equal(nextQuestion(lines, requirements), null);
    assert.deepEqual(toCartLines(lines), [
      { menuItemId: 'item_jollof', variantId: 'var_lg', modifierIds: ['mod_fish'], quantity: 1 },
    ]);
  });

  it('stacks identically configured lines and keeps different ones apart', () => {
    const first = mergeLines([], [line('item_jollof', { variantId: 'var_lg', modifierIds: ['mod_fish'] })]);
    const same = mergeLines(first, [line('item_jollof', { variantId: 'var_lg', modifierIds: ['mod_fish'] })]);
    assert.equal(same.length, 1);
    assert.equal(same[0]?.quantity, 2);

    const different = mergeLines(same, [
      line('item_jollof', { variantId: 'var_lg', modifierIds: ['mod_chicken'] }),
    ]);
    assert.equal(different.length, 2, 'a different protein is a different line');
  });

  it('caps a stacked quantity', () => {
    const merged = mergeLines([line('item_water', { quantity: 98 })], [line('item_water', { quantity: 5 })]);
    assert.equal(merged[0]?.quantity, 99);
  });
});
