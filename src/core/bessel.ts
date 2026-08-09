/**
 * Modified Bessel functions of the first and second kind, orders 0 and 1.
 *
 * These exist because the jet-breakup dispersion relation is written in them and
 * the long-wave approximation that avoids them is not free. The liquid side of
 * the relation carries I1(x)/I0(x) and the gas side K0(x)/K1(x); replacing the
 * first by its small-argument limit x/2 moves the most unstable wavenumber from
 * Rayleigh's 0.697 to 1/sqrt(2) = 0.7071, a 1.4% error that the validation suite
 * previously had to allow for in its tolerance. Replacing the second by anything
 * at all is worse, because K0/K1 is what decides how strongly a wave of a given
 * length feels the surrounding air, and it varies by an order of magnitude across
 * the range of wavenumbers the solver searches.
 *
 * Polynomial approximations from Abramowitz & Stegun, *Handbook of Mathematical
 * Functions* (1964), 9.8.1-9.8.8. Stated accuracies are 1.6e-7 or better for I0,
 * 8e-9 for I1, 1e-8 for K0 on the small branch and 1.9e-7 / 2.2e-7 on the large
 * branches -- far finer than anything downstream of them here needs, and cheap:
 * a dozen multiply-adds each.
 */

/** Modified Bessel function of the first kind, order 0. */
export function besselI0(x: number): number {
  const ax = Math.abs(x);
  if (ax < 3.75) {
    const t = (x / 3.75) ** 2;
    return (
      1.0 +
      t *
        (3.5156229 +
          t * (3.0899424 + t * (1.2067492 + t * (0.2659732 + t * (0.0360768 + t * 0.0045813)))))
    );
  }
  const t = 3.75 / ax;
  return (
    (Math.exp(ax) / Math.sqrt(ax)) *
    (0.39894228 +
      t *
        (0.01328592 +
          t *
            (0.00225319 +
              t *
                (-0.00157565 +
                  t *
                    (0.00916281 +
                      t * (-0.02057706 + t * (0.02635537 + t * (-0.01647633 + t * 0.00392377))))))))
  );
}

/** Modified Bessel function of the first kind, order 1. */
export function besselI1(x: number): number {
  const ax = Math.abs(x);
  let ans: number;
  if (ax < 3.75) {
    const t = (x / 3.75) ** 2;
    ans =
      ax *
      (0.5 +
        t *
          (0.87890594 +
            t *
              (0.51498869 +
                t * (0.15084934 + t * (0.02658733 + t * (0.00301532 + t * 0.00032411))))));
  } else {
    const t = 3.75 / ax;
    let a =
      0.02282967 + t * (-0.02895312 + t * (0.01787654 - t * 0.00420059));
    a = 0.39894228 + t * (-0.03988024 + t * (-0.00362018 + t * (0.00163801 + t * (-0.01031555 + t * a))));
    ans = a * (Math.exp(ax) / Math.sqrt(ax));
  }
  return x < 0 ? -ans : ans;
}

/** Modified Bessel function of the second kind, order 0. Diverges at x = 0. */
export function besselK0(x: number): number {
  if (x <= 0) return Infinity;
  if (x <= 2) {
    const t = (x * x) / 4;
    return (
      -Math.log(x / 2) * besselI0(x) +
      (-0.57721566 +
        t *
          (0.4227842 +
            t * (0.23069756 + t * (0.0348859 + t * (0.00262698 + t * (0.0001075 + t * 0.0000074))))))
    );
  }
  const t = 2 / x;
  return (
    (Math.exp(-x) / Math.sqrt(x)) *
    (1.25331414 +
      t *
        (-0.07832358 +
          t * (0.02189568 + t * (-0.01062446 + t * (0.00587872 + t * (-0.0025154 + t * 0.00053208))))))
  );
}

/** Modified Bessel function of the second kind, order 1. Diverges at x = 0. */
export function besselK1(x: number): number {
  if (x <= 0) return Infinity;
  if (x <= 2) {
    const t = (x * x) / 4;
    return (
      Math.log(x / 2) * besselI1(x) +
      (1 / x) *
        (1 +
          t *
            (0.15443144 +
              t *
                (-0.67278579 +
                  t * (-0.18156897 + t * (-0.01919402 + t * (-0.00110404 - t * 0.00004686))))))
    );
  }
  const t = 2 / x;
  return (
    (Math.exp(-x) / Math.sqrt(x)) *
    (1.25331414 +
      t *
        (0.23498619 +
          t * (-0.0365562 + t * (0.01504268 + t * (-0.00780353 + t * (0.00325614 - t * 0.00068245))))))
  );
}
