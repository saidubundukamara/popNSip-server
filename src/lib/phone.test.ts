import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ValidationError } from '@/lib/errors';
import {
  formatLocal,
  isSierraLeoneMobile,
  normaliseSierraLeoneMobile,
  phoneSearchFragment,
  toWhapiNumber,
} from '@/lib/phone';

describe('phone', () => {
  it('normalises the shapes people actually type', () => {
    const expected = '+23276123456';
    for (const input of [
      '076123456',
      '76123456',
      '076 123 456',
      '+232 76 123456',
      '+23276123456',
      '00232 76 123456',
      '232-76-123456',
      ' 076-123-456 ',
    ]) {
      assert.equal(normaliseSierraLeoneMobile(input), expected, `failed for ${input}`);
    }
  });

  it('strips an international prefix and a trunk zero together', () => {
    assert.equal(normaliseSierraLeoneMobile('00232076123456'), '+23276123456');
  });

  it('rejects the wrong number of digits', () => {
    // The regex matches the error message; the actionable detail is in issues.
    for (const bad of ['7612345', '761234567']) {
      assert.throws(() => normaliseSierraLeoneMobile(bad), (error: unknown) => {
        assert.ok(error instanceof ValidationError);
        assert.match(error.message, /Sierra Leone mobile number/);
        assert.match(error.issues[0]?.message ?? '', /8 digits/);
        return true;
      });
    }
  });

  it('rejects an unknown network code', () => {
    assert.throws(() => normaliseSierraLeoneMobile('11123456'), /network code/);
  });

  it('rejects an empty input', () => {
    assert.throws(() => normaliseSierraLeoneMobile('   '), /Enter a phone number/);
  });

  it('reports validity without throwing', () => {
    assert.equal(isSierraLeoneMobile('076123456'), true);
    assert.equal(isSierraLeoneMobile('nonsense'), false);
  });

  it('drops the plus only at the Whapi boundary', () => {
    assert.equal(toWhapiNumber('+23276123456'), '23276123456');
  });

  it('formats for a local reader', () => {
    assert.equal(formatLocal('+23276123456'), '076 123456');
  });
});

describe('phone search', () => {
  it('matches a stored E.164 from what staff actually type', () => {
    // The column holds '+23277900100'; none of these appear in it verbatim.
    for (const typed of ['077 900100', '077900100', '+232 77 900100', '00232 77900100', '77900100']) {
      const fragment = phoneSearchFragment(typed);
      assert.ok(fragment, `no fragment for ${typed}`);
      assert.ok('+23277900100'.includes(fragment), `${typed} -> ${fragment} does not match`);
    }
  });

  it('accepts a partial number that full validation would reject', () => {
    assert.equal(phoneSearchFragment('77900'), '77900');
    assert.equal(isSierraLeoneMobile('77900'), false);
  });

  it('ignores a fragment too short to be useful', () => {
    assert.equal(phoneSearchFragment('7'), null);
    assert.equal(phoneSearchFragment('PNS'), null);
  });
});
