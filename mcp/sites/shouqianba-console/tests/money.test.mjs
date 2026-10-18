import test from 'node:test';
import assert from 'node:assert/strict';
import {formatFen} from '../web/money.js';
test('分单位的数字字符串和数字一致，超大整数不丢精度',()=>{assert.equal(formatFen('12345'),'123.45');assert.equal(formatFen(12345),'123.45');assert.equal(formatFen('900719925474099312'),'9,007,199,254,740,993.12');assert.equal(formatFen('-15'),'-0.15');assert.equal(formatFen('100.00'),'1.00');});
test('报表脱敏或不可用占位原样显示，不变成0',()=>{assert.equal(formatFen('***'),'***');assert.equal(formatFen('--'),'--');assert.equal(formatFen(null),'—');assert.equal(formatFen(undefined),'—');assert.equal(formatFen(0),'0.00');assert.equal(formatFen('0'),'0.00');});
