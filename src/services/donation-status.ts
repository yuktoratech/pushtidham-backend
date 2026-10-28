import type {PipelineStage} from 'mongoose';

export const displayStatuses = ['completed', 'pending', 'processing', 'failed', 'canceled', 'rejected'] as const;
export type DonationDisplayStatus = typeof displayStatuses[number];
type DonationState = Record<string, unknown> & {status?: unknown; source?: unknown; confirmedPaymentAttempt?: unknown; verifiedAt?: unknown; verifiedBy?: unknown};
type AttemptState = {_id?: unknown; status?: unknown};

export function donationDisplayStatus(row: DonationState, attempt?: AttemptState): DonationDisplayStatus {
  if (row.status === 'completed') {
    if (row.source === 'offline') return row.verifiedAt && row.verifiedBy ? 'completed' : 'pending';
    // Preserve authoritative historical completed records without provider attempts.
    if (!attempt || (attempt.status === 'succeeded' && String(row.confirmedPaymentAttempt) === String(attempt._id))) return 'completed';
    return 'pending';
  }
  if (row.source === 'offline') return row.status === 'rejected' ? 'rejected' : 'pending';
  if (row.status === 'rejected' || attempt?.status === 'failed') return 'failed';
  if (attempt?.status === 'canceled') return 'canceled';
  if (attempt?.status === 'processing') return 'processing';
  return 'pending';
}

// Same rules expressed for paginated filtering and financial aggregation.
export function donationStatusStages(): PipelineStage[] {
  return [
    {$lookup: {from: 'paymentattempts', let: {donationId: '$_id', confirmedId: '$confirmedPaymentAttempt'}, pipeline: [
      {$match: {$expr: {$eq: ['$donation', '$$donationId']}}},
      {$set: {_confirmed: {$eq: ['$_id', '$$confirmedId']}}},
      {$sort: {_confirmed: -1, createdAt: -1, _id: -1}}, {$limit: 1},
    ], as: '_statusAttempts'}},
    {$set: {_statusAttempt: {$first: '$_statusAttempts'}}},
    {$set: {_displayStatus: {$switch: {branches: [
      {case: {$eq: ['$status', 'completed']}, then: {$cond: [{$eq: ['$source', 'offline']},
        {$cond: [{$and: [{$ne: [{$ifNull: ['$verifiedAt', null]}, null]}, {$ne: [{$ifNull: ['$verifiedBy', null]}, null]}]}, 'completed', 'pending']},
        {$cond: [{$or: [{$eq: [{$size: '$_statusAttempts'}, 0]}, {$and: [{$eq: ['$_statusAttempt.status', 'succeeded']}, {$eq: ['$_statusAttempt._id', '$confirmedPaymentAttempt']}]}]}, 'completed', 'pending']},
      ]}},
      {case: {$eq: ['$source', 'offline']}, then: {$cond: [{$eq: ['$status', 'rejected']}, 'rejected', 'pending']}},
      {case: {$or: [{$eq: ['$status', 'rejected']}, {$eq: ['$_statusAttempt.status', 'failed']}]}, then: 'failed'},
      {case: {$eq: ['$_statusAttempt.status', 'canceled']}, then: 'canceled'},
      {case: {$eq: ['$_statusAttempt.status', 'processing']}, then: 'processing'},
    ], default: 'pending'}}}},
  ];
}
