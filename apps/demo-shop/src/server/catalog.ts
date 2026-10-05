export interface Product {
  id: string;
  name: string;
  price: number;
  badge: string;
}

export const PRODUCTS: Product[] = [
  { id: 'mug', name: 'Developer mug', price: 18, badge: 'MG' },
  { id: 'hoodie', name: 'Feature-flag hoodie', price: 59, badge: 'HD' },
  { id: 'stickers', name: 'Sticker pack', price: 7, badge: 'ST' },
  { id: 'keyboard', name: 'Mechanical keyboard', price: 129, badge: 'KB' },
];

export const PLANS = [
  { id: 'free', name: 'Free', price: 0 },
  { id: 'pro', name: 'Pro', price: 19 },
  { id: 'team', name: 'Team', price: 49 },
];
