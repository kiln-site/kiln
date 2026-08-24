export const developmentBypassUserId = "kiln-development-bypass"

export function isDevelopmentBypassIdentity(user: {
  id: string
  isDevelopmentBypass: boolean
}): boolean {
  return user.isDevelopmentBypass && user.id === developmentBypassUserId
}
