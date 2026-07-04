export function isValidOrderNumber(orderNumber: string) {
  return /^UTV-\d{8}-\d{6}$/.test(orderNumber);
}
