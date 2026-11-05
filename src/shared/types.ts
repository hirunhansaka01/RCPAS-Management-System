export type AppRole = 'President' | 'Chief Organizer' | 'Authorized Organizer' | 'System Administrator';
export type Permission =
  | 'dashboard.view' | 'members.read' | 'members.write' | 'members.register' | 'members.export' | 'contacts.read'
  | 'creative.read' | 'creative.write' | 'equipment.read' | 'equipment.write' | 'equipment.allocate'
  | 'events.read' | 'events.write' | 'assignments.read' | 'assignments.write' | 'assignments.override'
  | 'reports.read' | 'reports.export' | 'settings.read' | 'settings.write' | 'users.manage' | 'audit.read';
export type MemberStatus = 'Active' | 'On Leave' | 'Alumni' | 'Inactive';
export type EventStatus = 'Planning' | 'Ready' | 'Confirmed' | 'Completed' | 'Cancelled';
export type EventPriority = 'Low' | 'Normal' | 'High' | 'Critical';
export type AssignmentStatus =
  | 'Proposed' | 'Contact Pending' | 'Contacted' | 'Confirmed' | 'Declined'
  | 'Reassignment Needed' | 'Completed' | 'Cancelled';
export type EquipmentAvailability = 'Available' | 'Allocated' | 'Unavailable' | 'Archived';
export type EquipmentCommitmentStatus = 'Offered' | 'Awaiting Confirmation' | 'Confirmed' | 'Declined' | 'Unavailable' | 'Released';

export const ASSIGNMENT_STATUSES: AssignmentStatus[] = ['Proposed', 'Contact Pending', 'Contacted', 'Confirmed', 'Declined', 'Reassignment Needed', 'Completed', 'Cancelled'];
export const EVENT_STATUSES: EventStatus[] = ['Planning', 'Ready', 'Confirmed', 'Completed', 'Cancelled'];
export const RESPONSE_STATUSES: AssignmentStatus[] = ['Contact Pending', 'Contacted', 'Confirmed', 'Declined', 'Completed'];

export interface SessionUser {
  id: number;
  openId: string;
  email: string;
  displayName: string;
  active: boolean;
  roles: AppRole[];
  permissions: Permission[];
}

export interface Member {
  id: number; memberCode: string; fullName: string; grade: string; className: string;
  membershipStart: string; status: MemberStatus; phone?: string | null; email?: string | null;
  experience?: string | null; skills?: string | null; availability?: string | null; notes?: string | null;
  roles: { id: number; name: string; level: string }[]; createdAt: string; updatedAt: string;
}

export interface Equipment {
  id: number; equipmentCode: string; assetId?: string | null; categoryId: number; categoryName: string;
  itemName?: string | null; brand: string; model: string; focalLength?: string | null; lensMount?: string | null;
  keywords?: string | null; quantity: number; ownership: 'Society Owned' | 'Personally Owned';
  ownerMemberId?: number | null; ownerMemberName?: string | null;
  responsibleMemberId?: number | null; responsibleMemberName?: string | null;
  conditionStatus: string; availability: EquipmentAvailability; notes?: string | null;
  createdAt: string; updatedAt: string;
}

/** One equipment search hit together with the member who owns/can provide it. */
export interface EquipmentOwnerHit {
  equipment: Equipment;
  owner: {
    id: number; memberCode: string; fullName: string; grade: string; className: string;
    status: MemberStatus; roles: { id: number; name: string; level: string }[];
    phone?: string | null; email?: string | null; availability?: string | null;
    assignmentsOnDate: number;
  };
  commitment: { status: EquipmentCommitmentStatus; notes?: string | null } | null;
}

export interface SocietyEvent {
  id: number; eventCode: string; name: string; description?: string | null; category: string;
  eventDate: string; startTime: string; startsAt: string; endsAt?: string | null;
  venue: string; organizerMemberId?: number | null; organizerName?: string | null;
  priority: EventPriority; requiredTeamSize: number; additionalInstructions?: string | null;
  photographyRequirements?: string | null; creativeRequirements?: string | null;
  status: EventStatus; isDraft: boolean; notes?: string | null;
  assignmentCount: number; equipmentCount: number;
  createdAt: string; updatedAt: string;
}

export interface Assignment {
  id: number; eventId: number; eventName: string; eventDate: string; startTime: string;
  startsAt: string; endsAt?: string | null; memberId: number;
  memberName: string; memberCode?: string; phone?: string | null; email?: string | null;
  responsibility: string; status: AssignmentStatus; notes?: string | null;
  contactedAt?: string | null; contactedByName?: string | null; confirmedAt?: string | null;
  createdAt: string; updatedAt?: string;
}

export interface EventReadiness {
  event: SocietyEvent;
  roles: { responsibility: string; required: number; assigned: number; confirmed: number }[];
  assignments: Assignment[];
  equipment: { equipmentId: number; equipmentCode: string; label: string; ownerName: string | null; status: EquipmentCommitmentStatus }[];
  summary: {
    requiredTeamSize: number; assigned: number; confirmed: number; awaitingResponse: number;
    declined: number; unconfirmedEquipment: number; sameDateConflicts: number; ready: boolean;
    blockers: string[];
  };
}

export interface DashboardData {
  metrics: {
    totalMembers: number; activeMembers: number; photographers: number; editors: number;
    designers: number; videographers: number; upcomingEvents: number; availableEquipment: number;
    awaitingConfirmation: number; pendingEvents: number; unfilledRoles: number;
    equipmentConfirmed: number; equipmentAwaiting: number;
  };
  roleDistribution: { name: string; count: number }[];
  gradeDistribution: { grade: string; className: string; count: number }[];
  upcomingEvents: SocietyEvent[];
  recentAssignments: Assignment[];
  /** `null` when the signed-in role does not hold `audit.read` — never faked. */
  recentActivity: { id: number; action: string; entityType: string; entityId?: string | null; details: unknown; createdAt: string; actorName?: string | null }[] | null;
  welcome: {
    displayName: string; roles: AppRole[]; greeting: string;
    upcoming: number; awaitingResponses: number; pendingEvents: number; unfilledRoles: number;
    equipmentAwaiting: number; canRegisterMember: boolean; canCreateEvent: boolean;
    canManageMembers: boolean; canViewReports: boolean;
  };
}

export interface ApiError { error: string; code?: string; details?: Record<string, string>; }
