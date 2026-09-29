import { z } from "zod";
const text = z.string().trim().min(1).max(200),
  optional = z.string().max(4000).optional().default(""),
  num = z.coerce.number().finite().min(0).max(1000000000),
  positive = num.refine((v) => v > 0, "Must be greater than zero"),
  id = z.string().regex(/^[a-f\d]{24}$/i),
  date = z.string().refine((v) => !Number.isNaN(Date.parse(v)), "Invalid date"),
  money = num,
  weight = num;
export { z, text, optional, num, positive, id, date };
export const schemas = {
  customers: z.object({
    name: text,
    phone: optional,
    address: optional,
    reference: optional,
    notes: optional,
    openingBalance: z.coerce.number().finite().min(-1e9).max(1e9).default(0),
    creditLimit: money.default(0),
  }),
  karigars: z.object({
    name: text,
    phone: optional,
    address: optional,
    skill: optional,
    makingRate: num.default(0),
    openingWeight: weight.default(0),
    purity: num.min(1).max(24).default(24),
    notes: optional,
  }),
  inventory: z
    .object({
      name: text,
      category: text,
      metal: z.enum(["gold", "silver", "platinum"]).default("gold"),
      purity: num.min(1).max(24),
      grossWeight: positive,
      stoneWeight: weight.default(0),
      makingMode: z.enum(["fixed", "perGram", "percent"]).default("fixed"),
      making: money.default(0),
      wastageMode: z.enum(["percent", "grams"]).default("percent"),
      wastage: num.default(0),
      stoneValue: money.default(0),
      cost: money.default(0),
      location: optional,
      karigarId: z.union([id, z.literal("")]).default(""),
      notes: optional,
      photos: z.array(id).max(8).default([]),
    })
    .refine(
      (d) => d.grossWeight > d.stoneWeight,
      "Stone weight must be less than gross weight",
    ),
  orders: z.object({
    customerId: id,
    name: text,
    items: z
      .array(
        z.object({
          description: text,
          targetWeight: positive,
          purity: num.min(1).max(24),
          stones: optional,
        }),
      )
      .min(1)
      .max(30),
    measurements: optional,
    notes: optional,
    budget: money.default(0),
    advance: money.default(0),
    dueDate: date,
    karigarId: z.union([id, z.literal("")]).default(""),
    ratePolicy: z.enum(["booking", "delivery", "locked"]),
    lockedRate: money.default(0),
    paymentSchedule: optional,
    photos: z.array(id).max(8).default([]),
  }),
  repairs: z.object({
    customerId: id,
    name: text,
    weight: positive,
    purity: num.min(1).max(24).default(22),
    condition: text,
    serviceCharge: money.default(0),
    metalAdded: weight.default(0),
    metalRemoved: weight.default(0),
    dueDate: date,
    assignee: optional,
    notes: optional,
    photos: z.array(id).max(8).default([]),
  }),
  expenses: z.object({
    name: text,
    amount: positive,
    method: z.enum(["cash", "bank", "card", "transfer"]),
    date: date,
    notes: optional,
  }),
  branches: z.object({ name: text, address: optional, phone: optional }),
  support: z.object({ name: text, notes: text }),
};
export const profileSchema = z.object({
  name: text,
  ownerName: optional,
  phone: optional,
  email: optional,
  address: optional,
  city: optional,
  registration: optional,
  website: optional,
  footer: optional,
  bank: optional,
  terms: optional,
  logoId: z.union([id, z.literal("")]).default(""),
  invoiceLanguage: z.enum(["en", "ur", "bilingual"]).default("en"),
  taxPercent: num.max(100).default(0),
  allowedWastage: num.max(100).default(2),
  sessionHours: num.min(1).max(24).default(8),
  categories: z
    .array(text)
    .max(50)
    .default([
      "Ring",
      "Bangle",
      "Necklace",
      "Chain",
      "Earrings",
      "Bridal set",
      "Pendant",
    ]),
});
export const saleSchema = z.object({
  customerId: id,
  items: z.array(id).min(1).max(50),
  discount: money.default(0),
  taxPercent: num.max(100).optional(),
  payments: z
    .array(
      z.object({
        method: z.enum(["cash", "bank", "card", "transfer"]),
        amount: positive,
      }),
    )
    .max(10)
    .default([]),
  oldGoldId: z.union([id, z.literal("")]).default(""),
  credit: money.default(0),
  orderId: z.union([id, z.literal("")]).default(""),
  idempotencyKey: z.string().min(16).max(100),
});
export const oldSchema = z.object({
  customerId: id,
  name: text,
  weight: positive,
  purity: num.min(1).max(24),
  deductions: weight.default(0),
  loss: weight.default(0),
  rate24: positive,
  mode: z.enum(["cash", "exchange"]),
  notes: optional,
});

schemas.drafts = saleSchema;
