const EPS = 1e-14;
const FPMIN = 1e-300;

export function logGamma(x: number): number {
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - logGamma(1 - x);
  const z = x - 1;
  let a = c[0]!;
  const t = z + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i]! / (z + i);
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

function gammaSeries(a: number, x: number): number {
  let ap = a;
  let sum = 1 / a;
  let del = sum;
  for (let n = 0; n < 10000; n++) {
    ap += 1;
    del *= x / ap;
    sum += del;
    if (Math.abs(del) < Math.abs(sum) * EPS) break;
  }
  return sum * Math.exp(-x + a * Math.log(x) - logGamma(a));
}

function gammaContinuedFraction(a: number, x: number): number {
  let b = x + 1 - a;
  let c = 1 / FPMIN;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 10000; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = b + an / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return Math.exp(-x + a * Math.log(x) - logGamma(a)) * h;
}

export function regularizedGammaQ(a: number, x: number): number {
  if (x <= 0) return 1;
  if (x < a + 1) return 1 - gammaSeries(a, x);
  return gammaContinuedFraction(a, x);
}

export function chiSquareSurvival(statistic: number, df: number): number {
  if (df <= 0 || !Number.isFinite(statistic)) return 1;
  return Math.min(1, Math.max(0, regularizedGammaQ(df / 2, statistic / 2)));
}

function betaContinuedFraction(a: number, b: number, x: number): number {
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 10000; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

export function regularizedBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  if (x < (a + 1) / (a + b + 2)) return (front * betaContinuedFraction(a, b, x)) / a;
  return 1 - (front * betaContinuedFraction(b, a, 1 - x)) / b;
}

export function studentTCdf(t: number, df: number): number {
  if (!Number.isFinite(t)) return t > 0 ? 1 : 0;
  const x = df / (df + t * t);
  const tail = 0.5 * regularizedBeta(x, df / 2, 0.5);
  return t >= 0 ? 1 - tail : tail;
}

export function studentTQuantile(p: number, df: number): number {
  if (df > 1e7) return normalQuantile(p);
  let lo = -1000;
  let hi = 1000;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (studentTCdf(mid, df) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const ans =
    t *
    Math.exp(
      -z * z -
        1.26551223 +
        t *
          (1.00002368 +
            t *
              (0.37409196 +
                t *
                  (0.09678418 +
                    t *
                      (-0.18628806 +
                        t *
                          (0.27886807 +
                            t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))),
    );
  return sign * (1 - ans);
}

export function normalCdf(z: number): number {
  if (z < -40) return 0;
  if (z > 40) return 1;
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

export function normalQuantile(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1,
    2.506628277459239,
  ];
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1,
    -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968,
    2.938163982698783,
  ];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const low = 0.02425;
  let x: number;
  if (p < low) {
    const q = Math.sqrt(-2 * Math.log(p));
    x =
      (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  } else if (p <= 1 - low) {
    const q = p - 0.5;
    const r = q * q;
    x =
      ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) /
      (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x =
      -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  return x;
}

export interface ProportionTest {
  controlRate: number;
  treatmentRate: number;
  difference: number;
  relativeLift: number;
  ciLow: number;
  ciHigh: number;
  z: number;
  pValue: number;
  significant: boolean;
}

export function twoProportionZTest(
  controlConversions: number,
  controlUnits: number,
  treatmentConversions: number,
  treatmentUnits: number,
  alpha = 0.05,
): ProportionTest {
  const p1 = controlUnits > 0 ? controlConversions / controlUnits : 0;
  const p2 = treatmentUnits > 0 ? treatmentConversions / treatmentUnits : 0;
  const difference = p2 - p1;
  const pooled =
    controlUnits + treatmentUnits > 0
      ? (controlConversions + treatmentConversions) / (controlUnits + treatmentUnits)
      : 0;
  const sePooled = Math.sqrt(
    pooled * (1 - pooled) * (1 / Math.max(controlUnits, 1) + 1 / Math.max(treatmentUnits, 1)),
  );
  const z = sePooled > 0 ? difference / sePooled : 0;
  const pValue = sePooled > 0 ? 2 * (1 - normalCdf(Math.abs(z))) : 1;
  const se = Math.sqrt(
    (p1 * (1 - p1)) / Math.max(controlUnits, 1) + (p2 * (1 - p2)) / Math.max(treatmentUnits, 1),
  );
  const critical = normalQuantile(1 - alpha / 2);
  const ciLow = difference - critical * se;
  const ciHigh = difference + critical * se;
  return {
    controlRate: p1,
    treatmentRate: p2,
    difference,
    relativeLift: p1 > 0 ? difference / p1 : 0,
    ciLow,
    ciHigh,
    z,
    pValue: Math.min(1, Math.max(0, pValue)),
    significant: pValue < alpha && controlUnits > 0 && treatmentUnits > 0,
  };
}

export interface MeanSummary {
  n: number;
  mean: number;
  variance: number;
}

export interface WelchTest {
  difference: number;
  relativeLift: number;
  ciLow: number;
  ciHigh: number;
  t: number;
  df: number;
  pValue: number;
  significant: boolean;
}

export function welchTTest(control: MeanSummary, treatment: MeanSummary, alpha = 0.05): WelchTest {
  const difference = treatment.mean - control.mean;
  const v1 = control.n > 0 ? control.variance / control.n : 0;
  const v2 = treatment.n > 0 ? treatment.variance / treatment.n : 0;
  const se = Math.sqrt(v1 + v2);
  if (control.n < 2 || treatment.n < 2 || se === 0) {
    return {
      difference,
      relativeLift: control.mean !== 0 ? difference / control.mean : 0,
      ciLow: difference,
      ciHigh: difference,
      t: 0,
      df: 0,
      pValue: 1,
      significant: false,
    };
  }
  const t = difference / se;
  const df = (v1 + v2) ** 2 / ((v1 * v1) / (control.n - 1) + (v2 * v2) / (treatment.n - 1));
  const pValue = 2 * (1 - studentTCdf(Math.abs(t), df));
  const critical = studentTQuantile(1 - alpha / 2, df);
  return {
    difference,
    relativeLift: control.mean !== 0 ? difference / control.mean : 0,
    ciLow: difference - critical * se,
    ciHigh: difference + critical * se,
    t,
    df,
    pValue: Math.min(1, Math.max(0, pValue)),
    significant: pValue < alpha,
  };
}

export interface SrmResult {
  chiSquare: number;
  pValue: number;
  degreesOfFreedom: number;
  mismatch: boolean;
}

export function sampleRatioMismatch(
  observed: number[],
  expectedShares: number[],
  threshold = 0.001,
): SrmResult {
  const total = observed.reduce((s, x) => s + x, 0);
  const shareSum = expectedShares.reduce((s, x) => s + x, 0);
  let chiSquare = 0;
  let df = -1;
  observed.forEach((o, i) => {
    const share = (expectedShares[i] ?? 0) / (shareSum || 1);
    if (share <= 0) return;
    const expected = total * share;
    chiSquare += (o - expected) ** 2 / expected;
    df++;
  });
  if (total === 0 || df < 1)
    return { chiSquare: 0, pValue: 1, degreesOfFreedom: Math.max(df, 0), mismatch: false };
  const pValue = chiSquareSurvival(chiSquare, df);
  return { chiSquare, pValue, degreesOfFreedom: df, mismatch: pValue < threshold };
}

export function sampleSizePerVariation(
  baselineRate: number,
  relativeMde: number,
  alpha = 0.05,
  power = 0.8,
  variants = 2,
): number {
  const p1 = baselineRate;
  const p2 = Math.min(0.999999, baselineRate * (1 + relativeMde));
  const adjustedAlpha = alpha / Math.max(1, variants - 1);
  const zAlpha = normalQuantile(1 - adjustedAlpha / 2);
  const zBeta = normalQuantile(power);
  const pBar = (p1 + p2) / 2;
  const numerator =
    zAlpha * Math.sqrt(2 * pBar * (1 - pBar)) + zBeta * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2));
  return Math.ceil((numerator * numerator) / ((p2 - p1) * (p2 - p1)));
}
