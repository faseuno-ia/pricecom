import { z } from "zod";

export const providerSchema = z.object({
  name: z.string().min(1, "El nombre es requerido").max(100),
  baseUrl: z.string().url("URL inválida"),
  requiresLogin: z.boolean().default(false),
  username: z.string().optional().nullable(),
  password: z.string().optional().nullable(),
  isActive: z.boolean().default(true),
  notes: z.string().optional().nullable(),
});

export const scraperConfigSchema = z.object({
  providerId: z.string(),
  productCardSelector: z.string().optional().nullable(),
  skuSelector: z.string().optional().nullable(),
  nameSelector: z.string().optional().nullable(),
  descriptionSelector: z.string().optional().nullable(),
  priceSelector: z.string().optional().nullable(),
  oldPriceSelector: z.string().optional().nullable(),
  stockSelector: z.string().optional().nullable(),
  categorySelector: z.string().optional().nullable(),
  imageSelector: z.string().optional().nullable(),
  productUrlSelector: z.string().optional().nullable(),
  nextPageSelector: z.string().optional().nullable(),
  waitForSelector: z.string().optional().nullable(),
  loginUsernameSelector: z.string().optional().nullable(),
  loginPasswordSelector: z.string().optional().nullable(),
  loginSubmitSelector: z.string().optional().nullable(),
  imageFilenamePrefix: z.string().optional().nullable(),
  maxPages: z.number().int().min(1).max(500).default(10),
});

export const startExtractionSchema = z.object({
  providerId: z.string().min(1, "Seleccioná un proveedor"),
  startUrl: z.string().url("URL inválida").optional().nullable().or(z.literal("")),
});

export type ProviderInput = z.infer<typeof providerSchema>;
export type ScraperConfigInput = z.infer<typeof scraperConfigSchema>;
export type StartExtractionInput = z.infer<typeof startExtractionSchema>;
