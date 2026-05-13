// Interfaz base que todos los conectores de ecommerce deben implementar.
// Cada plataforma (TiendaNube, Shopify, WooCommerce) tendrá su propia
// implementación en su carpeta correspondiente.

export interface ProductPayload {
  sku: string;
  name: string;
  description?: string;
  price: number;
  images?: string[];
  categoryName?: string;
}

export interface IEcommerceIntegration {
  /** Crear un producto nuevo en la tienda */
  createProduct(product: ProductPayload): Promise<{ externalId: string }>;

  /** Actualizar un producto existente */
  updateProduct(externalId: string, product: Partial<ProductPayload>): Promise<void>;

  /** Subir imagen y devolver URL externa */
  uploadImage(imageUrl: string): Promise<string>;

  /** Verificar si un SKU ya existe en la tienda */
  productExistsBySku(sku: string): Promise<boolean>;
}
