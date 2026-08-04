import { databases, type Table } from 'harper';
import type {
	Shop,
	ShopCredential,
	AppAuditEvent,
	WebhookDelivery,
	OperationalEvent,
	OrderProjection,
	Expectation,
	GapFinding,
	FlowAggregate,
	WorkerCheckpoint,
} from './model.ts';

// Table handles, resolved from the named sightline_* databases. Centralized so
// the database grouping lives in one place (see schema.graphql).
const core = databases.sightline_core;
const ledger = databases.sightline_ledger;

export const Shops = core.Shop as unknown as Table<Shop>;
export const Credentials = core.ShopCredential as unknown as Table<ShopCredential>;
export const AuditEvents = core.AppAuditEvent as unknown as Table<AppAuditEvent>;

export const Deliveries = ledger.WebhookDelivery as unknown as Table<WebhookDelivery>;
export const Events = ledger.OperationalEvent as unknown as Table<OperationalEvent>;
export const Projections = ledger.OrderProjection as unknown as Table<OrderProjection>;
export const Expectations = ledger.Expectation as unknown as Table<Expectation>;
export const Findings = ledger.GapFinding as unknown as Table<GapFinding>;
export const Aggregates = ledger.FlowAggregate as unknown as Table<FlowAggregate>;
export const Checkpoints = ledger.WorkerCheckpoint as unknown as Table<WorkerCheckpoint>;
