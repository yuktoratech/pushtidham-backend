import {before, after, test} from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import {MongoMemoryReplSet} from 'mongodb-memory-server';
import {Donation} from '../src/models/donation.js';
import {PaymentAttempt} from '../src/models/payment-attempt.js';
import {PaymentAdjustment} from '../src/models/payment-adjustment.js';
import {donationViews} from '../src/services/donation-views.js';
import {DonationService} from '../src/services/donations.js';
import {FinancialReportService} from '../src/services/financial-reports.js';
import {exportDonations} from '../src/services/donation-export.js';
import {displayStatuses} from '../src/services/donation-status.js';

let replica: MongoMemoryReplSet;
before(async () => {
  replica = await MongoMemoryReplSet.create({replSet: {count: 1}});
  await mongoose.connect(replica.getUri());
  await Promise.all([Donation.init(), PaymentAttempt.init(), PaymentAdjustment.init()]);
});
after(async () => { await mongoose.disconnect(); await replica?.stop(); });

test('canonical donation statuses agree across list, filters, reports and CSV without changing raw attempts', async () => {
  const owner = new mongoose.Types.ObjectId();
  const cases: Array<{name: string; status: 'completed' | 'pending' | 'rejected'; attempt?: InstanceType<typeof PaymentAttempt>['status']; confirmed?: boolean; offline?: boolean; verified?: boolean; expected: typeof displayStatuses[number]}> = [
    {name: 'settled', status: 'completed', attempt: 'succeeded', confirmed: true, expected: 'completed'},
    {name: 'action', status: 'pending', attempt: 'requires_action', expected: 'pending'},
    {name: 'created', status: 'pending', attempt: 'created', expected: 'pending'},
    {name: 'verification', status: 'pending', attempt: 'verification_pending', expected: 'pending'},
    {name: 'processing', status: 'pending', attempt: 'processing', expected: 'processing'},
    {name: 'failed', status: 'pending', attempt: 'failed', expected: 'failed'},
    {name: 'canceled', status: 'pending', attempt: 'canceled', expected: 'canceled'},
    {name: 'unconfirmed-success', status: 'pending', attempt: 'succeeded', expected: 'pending'},
    {name: 'offline-paid', status: 'completed', offline: true, verified: true, expected: 'completed'},
    {name: 'offline-unverified', status: 'completed', offline: true, expected: 'pending'},
    {name: 'offline-pending', status: 'pending', offline: true, expected: 'pending'},
    {name: 'offline-rejected', status: 'rejected', offline: true, expected: 'rejected'},
    {name: 'online-rejected', status: 'rejected', expected: 'failed'},
  ];
  const makeAttempt = (donation: mongoose.Types.ObjectId, status: InstanceType<typeof PaymentAttempt>['status'], suffix: string, createdAt?: Date) => PaymentAttempt.create({donation, provider: 'stripe', methodFamily: 'card', status, baseDonationCents: 100, feeContributionCents: 0, totalChargeCents: 100, currency: 'USD', donorNameSnapshot: 'Fixture', donorEmailSnapshot: 'fixture@example.test', idempotencyKey: `status-${suffix}-key`, createdAt});
  for (const item of cases) {
    const row = await Donation.create({donationNumber: `STATUS-${item.name}`, user: owner, donorName: 'Fixture', donorEmail: 'fixture@example.test', type: 'general', giving: new mongoose.Types.ObjectId(), designationTitle: 'Fixture Seva', amountCents: 100, currency: 'USD', paymentMethod: item.offline ? 'offline' : 'card', source: item.offline ? 'offline' : 'online', status: item.status, ...(item.verified ? {verifiedAt: new Date(), verifiedBy: new mongoose.Types.ObjectId()} : {})});
    if (item.attempt) {
      const attempt = await makeAttempt(row._id, item.attempt, item.name);
      if (item.confirmed) {
        await Donation.updateOne({_id: row._id}, {$set: {confirmedPaymentAttempt: attempt._id}});
        await makeAttempt(row._id, 'requires_action', 'older', new Date('2020-01-01'));
        await makeAttempt(row._id, 'requires_action', 'newer', new Date('2030-01-01'));
        await PaymentAdjustment.create({donation: row._id, attempt: attempt._id, provider: 'stripe', type: 'refund', status: 'succeeded', amountCents: 10, currency: 'USD', providerReference: 'fixture-refund', occurredAt: new Date()});
      }
    }
  }
  const raw = await Donation.find().lean();
  const views = await donationViews(raw as Parameters<typeof donationViews>[0], true);
  for (const item of cases) {
    const view = views.find(v => v.donationNumber === `STATUS-${item.name}`)!;
    assert.equal(view.displayStatus, item.expected, item.name);
    if (item.name === 'settled') {
      assert.equal(view.paymentLifecycle, 'succeeded');
      assert.equal(view.providerVerified, true);
      assert.equal(view.adjustmentStatus, 'partially_refunded');
      assert.equal(view.receiptEligible, false);
    }
    if (item.name === 'action') {
      assert.equal(view.paymentLifecycle, 'requires_action');
      assert.equal(view.recordKind, 'online');
      assert.equal(view.providerVerified, false);
      assert.equal(view.receiptEligible, false);
    }
  }
  for (const status of displayStatuses) {
    const expected = cases.filter(v => v.expected === status).length;
    const list = await new DonationService().list({page: 1, limit: 100, status}, owner);
    assert.equal(list.pagination.total, expected, `filter ${status}`);
    assert.ok(list.data.every(row => row.displayStatus === status));
    const report = await new FinancialReportService().summary({status});
    assert.equal(report.summary.records, expected, `report ${status}`);
    if (status !== 'completed') assert.equal(report.summary.confirmedRecords, 0);
    const app = express();
    app.get('/csv', async (_req, res) => { await exportDonations({page: 1, limit: 100, status}, res); });
    const csv = await request(app).get('/csv');
    assert.equal(csv.status, 200);
    const lines = csv.text.split('\r\n').filter(line => line.startsWith('"STATUS-'));
    assert.equal(lines.length, expected);
    assert.ok(lines.every(line => line.includes(`,"${status}",`)));
  }
  assert.equal(await PaymentAttempt.countDocuments({status: 'requires_action'}), 3);
  const settled = raw.find(row => row.donationNumber === 'STATUS-settled')!;
  assert.equal((await new DonationService().list({page: 1, limit: 20, status: 'completed', giving: String(settled.giving)}, owner)).pagination.total, 1);
  assert.equal((await new DonationService().list({page: 1, limit: 20, status: 'completed'}, new mongoose.Types.ObjectId())).pagination.total, 0);
});
