import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  extractSelection,
  inboundMessageOf,
  isCartMessage,
  parseGlobalCommand,
  stripReplyPrefix,
  toE164,
  withoutPreview,
} from '@/lib/whatsapp_utils';

describe('whatsapp reply prefixes', () => {
  it('strips the transport prefix WhatsApp adds to a reply', () => {
    // Sent as `cat_rice`, returned as `ListV3:cat_rice`.
    assert.equal(stripReplyPrefix('ListV3:cat_rice'), 'cat_rice');
    assert.equal(stripReplyPrefix('ButtonsV3:confirm'), 'confirm');
  });

  it('leaves an unprefixed id alone', () => {
    assert.equal(stripReplyPrefix('confirm'), 'confirm');
    assert.equal(stripReplyPrefix(null), null);
  });

  it('takes a button reply as readily as a list reply', () => {
    assert.equal(extractSelection({ reply: { list_reply: { id: 'ListV3:a' } } }), 'a');
    assert.equal(extractSelection({ reply: { buttons_reply: { id: 'ButtonsV3:b' } } }), 'b');
    assert.equal(extractSelection({ text: { body: 'hello' } }), null);
  });
});

describe('global commands', () => {
  it('accepts the slash form and the bare word alike', () => {
    // A bot that only answers '/menu' looks broken to everyone who types 'menu'.
    for (const input of ['menu', '/menu', ' MENU ', 'Hi', 'hello', 'start']) {
      assert.equal(parseGlobalCommand(input), 'menu', `failed for ${input}`);
    }
  });

  it('maps the words people reach for when stuck', () => {
    assert.equal(parseGlobalCommand('cancel'), 'cancel');
    assert.equal(parseGlobalCommand('stop'), 'cancel');
    assert.equal(parseGlobalCommand('human'), 'human');
    assert.equal(parseGlobalCommand('agent'), 'human');
    assert.equal(parseGlobalCommand('restart'), 'restart');
  });

  it('is not fooled by ordinary conversation', () => {
    assert.equal(parseGlobalCommand('can I get the menu please'), null);
    assert.equal(parseGlobalCommand(null), null);
    assert.equal(parseGlobalCommand(''), null);
  });
});

describe('inbound classification', () => {
  it('recognises a catalog cart', () => {
    assert.equal(isCartMessage({ type: 'order', order: { order_id: 'o1' } }), true);
    assert.equal(isCartMessage({ type: 'text', text: { body: 'hi' } }), false);
    // An order message with no id is not something we can fetch.
    assert.equal(isCartMessage({ type: 'order', order: {} }), false);
  });

  it('ignores our own outbound echo', () => {
    // Whapi delivers what we sent back on the same webhook; acting on it means
    // the bot replies to itself.
    assert.equal(inboundMessageOf({ messages: [{ from: '23276123456', from_me: true }] }), null);
  });

  it('ignores status-only payloads', () => {
    assert.equal(inboundMessageOf({ statuses: [{}] }), null);
    assert.equal(inboundMessageOf({}), null);
  });

  it('accepts a real inbound message', () => {
    const message = inboundMessageOf({ messages: [{ from: '23276123456', type: 'text' }] });
    assert.equal(message?.from, '23276123456');
  });

  it('converts a Whapi number to stored E.164', () => {
    assert.equal(toE164('23276123456'), '+23276123456');
    assert.equal(toE164('+23276123456'), '+23276123456');
  });

  it('drops the base64 preview so it can never be logged', () => {
    const stripped = withoutPreview({ order_id: 'o1', preview: 'iVBORw0KGgo...' });
    assert.deepEqual(stripped, { order_id: 'o1' });
    assert.equal('preview' in stripped, false);
  });
});
