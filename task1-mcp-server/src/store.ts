import { randomUUID } from "node:crypto";

export type Customer = {
  customer_id: string;
  name: string;
  email: string;
  status: "active" | "closed";
  refundable_balance: number;
};

const customers = new Map<string, Customer>([
  ["CUST-10001", { customer_id: "CUST-10001", name: "Ada Lovelace", email: "ada@example.com", status: "active", refundable_balance: 250 }],
  ["CUST-10002", { customer_id: "CUST-10002", name: "Grace Hopper", email: "grace@example.com", status: "active", refundable_balance: 75.5 }],
  ["CUST-20003", { customer_id: "CUST-20003", name: "Alan Turing", email: "alan@example.com", status: "closed", refundable_balance: 100 }],
  ["CUST-30004", { customer_id: "CUST-30004", name: "Edsger Dijkstra", email: "edsger@example.com", status: "active", refundable_balance: 1000 }],
]);

export function getCustomer(id: string) {
  return customers.get(id);
}

// returns an error message, or the queued refund
export function refund(id: string, amount: number, reason: string) {
  const customer = customers.get(id);
  if (!customer) return "Customer not found";
  if (customer.status === "closed") return "Account is closed, refunds can't be issued";
  if (amount > customer.refundable_balance) return "Refund amount exceeds the refundable balance";

  customer.refundable_balance = Math.round((customer.refundable_balance - amount) * 100) / 100;
  return {
    refund_id: `rf_${randomUUID()}`,
    customer_id: id,
    amount,
    reason,
    status: "queued",
    created_at: new Date().toISOString(),
    remaining_refundable_balance: customer.refundable_balance,
  };
}
