import { z } from 'zod';

import { MEMBER_CODE_PATTERN, MEMBER_CODE_FORMAT_MESSAGE } from './member-id.js';

export const memberSchema = z.object({
  memberCode: z.string().trim().max(60).regex(MEMBER_CODE_PATTERN, MEMBER_CODE_FORMAT_MESSAGE), fullName: z.string().trim().min(2).max(160),
  grade: z.string().trim().min(1).max(20), className: z.string().trim().min(1).max(40),
  membershipStart: z.string().date(), status: z.enum(['Active', 'On Leave', 'Alumni', 'Inactive']),
  phone: z.string().trim().max(40).optional().or(z.literal('')), email: z.string().email().max(191).optional().or(z.literal('')),
  experience: z.string().max(5000).optional().or(z.literal('')), skills: z.string().max(5000).optional().or(z.literal('')),
  availability: z.string().max(255).optional().or(z.literal('')), notes: z.string().max(5000).optional().or(z.literal('')),
  roleIds: z.array(z.number().int().positive()).max(12).default([]),
});

export const equipmentSchema = z.object({
  // Optional: the server assigns an internal equipment code when it is omitted.
  equipmentCode: z.string().trim().min(2).max(60).optional().or(z.literal('')),
  assetId: z.string().trim().max(80).optional().or(z.literal('')),
  categoryId: z.number().int().positive(), brand: z.string().trim().min(1).max(100), model: z.string().trim().min(1).max(120),
  itemName: z.string().trim().max(120).optional().or(z.literal('')),
  focalLength: z.string().trim().max(60).optional().or(z.literal('')),
  lensMount: z.string().trim().max(60).optional().or(z.literal('')),
  keywords: z.string().trim().max(300).optional().or(z.literal('')),
  quantity: z.number().int().positive().max(10000), ownership: z.enum(['Society Owned', 'Personally Owned']),
  responsibleMemberId: z.number().int().positive().nullable().optional(), conditionStatus: z.enum(['Excellent', 'Good', 'Needs Service', 'Damaged', 'Unavailable']),
  availability: z.enum(['Available', 'Allocated', 'Unavailable', 'Archived']), notes: z.string().max(5000).optional().or(z.literal('')),
});

const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;

export const eventSchema = z.object({
  eventCode: z.string().trim().min(2).max(60), name: z.string().trim().min(2).max(180),
  description: z.string().max(5000).optional().or(z.literal('')),
  category: z.string().trim().min(1).max(80),
  // Single-day events: a date plus exactly one start time. No end time is required.
  eventDate: z.string().date('A valid event date is required (YYYY-MM-DD).'),
  startTime: z.string().regex(timePattern, 'Start time must be in 24-hour HH:MM format.'),
  endsAt: z.string().datetime({ offset: true }).optional().nullable().or(z.literal('')),
  venue: z.string().trim().min(2).max(180), organizerMemberId: z.number().int().positive().nullable().optional(),
  priority: z.enum(['Low', 'Normal', 'High', 'Critical']).default('Normal'),
  requiredTeamSize: z.number().int().min(0).max(500).default(0),
  additionalInstructions: z.string().max(5000).optional().or(z.literal('')),
  photographyRequirements: z.string().max(3000).optional().or(z.literal('')), creativeRequirements: z.string().max(3000).optional().or(z.literal('')),
  status: z.enum(['Planning', 'Ready', 'Confirmed', 'Completed', 'Cancelled']).default('Planning'),
  isDraft: z.boolean().default(false),
  notes: z.string().max(5000).optional().or(z.literal('')),
}).refine((v) => !v.endsAt || new Date(v.endsAt).getTime() > new Date(`${v.eventDate}T${v.startTime}:00`).getTime(),
  { path: ['endsAt'], message: 'End time must be after the start time' });

export const assignmentSchema = z.object({
  eventId: z.number().int().positive(), memberId: z.number().int().positive(), responsibility: z.string().trim().min(2).max(100),
  status: z.enum(['Proposed', 'Contact Pending', 'Contacted', 'Confirmed', 'Declined', 'Reassignment Needed', 'Completed', 'Cancelled']),
  notes: z.string().max(3000).optional().or(z.literal('')),
  overrideWarnings: z.boolean().default(false), overrideReason: z.string().max(1000).optional().or(z.literal('')),
});

/** Contact / confirmation status change for one team assignment. */
export const contactUpdateSchema = z.object({
  status: z.enum(['Contact Pending', 'Contacted', 'Confirmed', 'Declined', 'Completed', 'Reassignment Needed']),
  notes: z.string().max(3000).optional().or(z.literal('')),
});

export const commitmentSchema = z.object({
  eventId: z.number().int().positive(), equipmentId: z.number().int().positive(),
  status: z.enum(['Offered', 'Awaiting Confirmation', 'Confirmed', 'Declined', 'Unavailable', 'Released']),
  notes: z.string().max(2000).optional().or(z.literal('')),
  override: z.boolean().default(false), overrideReason: z.string().max(1000).optional().or(z.literal('')),
});

/**
 * A structured gear requirement for one event. The link to `equipment` is
 * optional so a requirement can be recorded before any member owns the item
 * (for example a gimbal nobody has registered yet).
 */
export const requirementSchema = z.object({
  description: z.string().trim().min(2).max(160),
  equipmentId: z.number().int().positive().nullable().optional(),
  quantity: z.number().int().min(1).max(1000).default(1),
  priority: z.enum(['Optional', 'Required', 'Critical']).default('Required'),
  notes: z.string().max(2000).optional().or(z.literal('')),
});

export const requirementUpdateSchema = requirementSchema.partial();

/** Internal planning discussion post among authorized officials only. */
export const discussionSchema = z.object({ body: z.string().trim().min(1).max(4000) });

export const allocationSchema = z.object({
  equipmentId: z.number().int().positive(), eventId: z.number().int().positive(), quantity: z.number().int().positive(),
  issuedAt: z.string().datetime({ offset: true }).optional(), notes: z.string().max(2000).optional().or(z.literal('')),
});

export const listQuerySchema = z.object({ search: z.string().trim().max(160).optional().default(''), status: z.string().trim().max(40).optional(),
  grade: z.string().trim().max(20).optional(), className: z.string().trim().max(40).optional(), role: z.string().trim().max(100).optional(),
  category: z.string().trim().max(100).optional(), ownership: z.string().trim().max(40).optional(), from: z.string().optional(), to: z.string().optional(), sort: z.string().trim().max(80).optional(),
  group: z.string().trim().max(40).optional(), eventId: z.coerce.number().int().optional(),
  page: z.coerce.number().int().min(1).max(1000).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
