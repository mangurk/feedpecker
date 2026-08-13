// Shared rule semantics for the feed runtime and management interfaces.

function normalizeOriginRules(input) {
  const values = Array.isArray(input)
    ? input
    : typeof input === 'string' ? input.split(',') : [];
  return [...new Set(values.map(value => normalizeOrigin(value)).filter(Boolean))];
}

function originsEquivalent(left, right) {
  const leftName = normalizeOrigin(left);
  const rightName = normalizeOrigin(right);
  if (!leftName || !rightName) return false;
  const leftRegion = isRegionalAggregate(leftName);
  const rightRegion = isRegionalAggregate(rightName);
  if (leftRegion || rightRegion) return leftRegion && rightRegion && leftName === rightName;
  const leftCode = getCountryFlag(leftName);
  const rightCode = getCountryFlag(rightName);
  return leftCode && rightCode ? leftCode === rightCode : leftName === rightName;
}

function originMatchesRule(location, rule) {
  const locationName = normalizeOrigin(location);
  const ruleName = normalizeOrigin(rule);
  if (!locationName || !ruleName) return false;
  if (isRegionalAggregate(ruleName)) return locationName === ruleName || phraseOccurs(locationName, ruleName);
  const locationCode = getCountryFlag(locationName);
  const ruleCode = getCountryFlag(ruleName);
  if (locationCode && ruleCode) return locationCode === ruleCode;
  return phraseOccurs(locationName, ruleName);
}

function originIsBlocked(location, verified, rules, verifiedOnly = false) {
  if (!location || (verifiedOnly && verified !== true)) return false;
  return normalizeOriginRules(rules).some(rule => originMatchesRule(location, rule));
}
