import { z } from "zod";

export const providerSchema = z
  .object({
    name: z.string().min(1, "El nombre es requerido").max(100),
    providerType: z
      .enum(["SCRAPER", "MANUAL", "IMPORTED", "OWN_STOCK"])
      .default("SCRAPER"),
    // baseUrl es opcional para MANUAL/IMPORTED, requerida (y URL válida) para SCRAPER.
    // Aceptamos "" y lo normalizamos abajo.
    baseUrl: z.string().optional().nullable(),
    requiresLogin: z.boolean().default(false),
    username: z.string().optional().nullable(),
    password: z.string().optional().nullable(),
    isActive: z.boolean().default(true),
    notes: z.string().optional().nullable(),
    listDiscountPercent: z.number().min(0).max(100).default(0),
    /// Prefijo SKU comercial. Solo mayúsculas, dígitos y guiones; hasta 10 chars.
    /// Vacío permitido (default). Si llega null o undefined desde el form, lo
    /// normalizamos a "" en el transform.
    skuPrefix: z
      .string()
      .regex(
        /^[A-Z0-9-]{0,10}$/,
        "Solo mayúsculas, números y guiones (hasta 10 chars)"
      )
      .optional()
      .nullable(),
  })
  .superRefine((data, ctx) => {
    const url = data.baseUrl?.trim() ?? "";
    if (data.providerType === "SCRAPER") {
      if (!url) {
        ctx.addIssue({
          path: ["baseUrl"],
          code: z.ZodIssueCode.custom,
          message: "URL base requerida para proveedores con scraping",
        });
        return;
      }
      try {
        new URL(url);
      } catch {
        ctx.addIssue({
          path: ["baseUrl"],
          code: z.ZodIssueCode.custom,
          message: "URL inválida",
        });
      }
    } else if (url) {
      // Si la cargaron igual, validamos que sea URL válida — no es requerida pero
      // si la mandan tiene que estar bien formateada.
      try {
        new URL(url);
      } catch {
        ctx.addIssue({
          path: ["baseUrl"],
          code: z.ZodIssueCode.custom,
          message: "URL inválida",
        });
      }
    }
  })
  .transform((data) => ({
    ...data,
    baseUrl: data.baseUrl?.trim() || "",
    // requiresLogin solo aplica para SCRAPER
    requiresLogin: data.providerType === "SCRAPER" ? data.requiresLogin : false,
    // Normalizamos null/undefined a "" para que el campo de la DB siempre
    // tenga un string (NOT NULL en el schema).
    skuPrefix: (data.skuPrefix ?? "").trim().toUpperCase(),
  }));

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
