//! Small expression language for `generate` and masks.
//!
//! ```text
//! y <= height(x, z)
//! y <= 60 + 30 * fbm(x, z, 200) && y > 10
//! noise(x, y, z, 24) > 0.3 ? 1 : 0
//! ```
//! Variables: `x y z`; constants `pi e`; operators `+ - * / % ^ < <= > >= == != && || ! ?:`
//! (also `≤ ≥ ≠`). Functions: see `FUNCS`.

use crate::noise;
use crate::zones::Zones;
use anyhow::{bail, Result};

#[derive(Clone, Debug)]
pub enum Expr {
    Num(f64),
    X,
    Y,
    Z,
    Neg(Box<Expr>),
    Not(Box<Expr>),
    Bin(Op, Box<Expr>, Box<Expr>),
    If(Box<Expr>, Box<Expr>, Box<Expr>),
    Call(Func, Vec<Expr>),
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Op {
    Add,
    Sub,
    Mul,
    Div,
    Mod,
    Pow,
    Lt,
    Le,
    Gt,
    Ge,
    Eq,
    Ne,
    And,
    Or,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Func {
    Abs,
    Min,
    Max,
    Floor,
    Ceil,
    Round,
    Sqrt,
    Pow,
    Sin,
    Cos,
    Tan,
    Atan2,
    Exp,
    Ln,
    Clamp,
    Lerp,
    Smoothstep,
    Step,
    Noise,
    Fbm,
    Ridged,
    Worley,
    Rand,
    Height,
    Edge,
    Zone,
    Top,
    Dist,
}

pub const FUNCS: &[(&str, Func, &str)] = &[
    ("abs", Func::Abs, "abs(v)"),
    ("min", Func::Min, "min(a, b, ...)"),
    ("max", Func::Max, "max(a, b, ...)"),
    ("floor", Func::Floor, "floor(v)"),
    ("ceil", Func::Ceil, "ceil(v)"),
    ("round", Func::Round, "round(v)"),
    ("sqrt", Func::Sqrt, "sqrt(v)"),
    ("pow", Func::Pow, "pow(a, b)"),
    ("sin", Func::Sin, "sin(v)"),
    ("cos", Func::Cos, "cos(v)"),
    ("tan", Func::Tan, "tan(v)"),
    ("atan2", Func::Atan2, "atan2(y, x)"),
    ("exp", Func::Exp, "exp(v)"),
    ("ln", Func::Ln, "ln(v)"),
    ("log", Func::Ln, "log(v) natural log"),
    ("clamp", Func::Clamp, "clamp(v, lo, hi)"),
    ("lerp", Func::Lerp, "lerp(a, b, t)"),
    ("smoothstep", Func::Smoothstep, "smoothstep(e0, e1, v)"),
    ("step", Func::Step, "step(edge, v)"),
    ("noise", Func::Noise, "noise(x, z, scale) or noise(x, y, z, scale): Perlin in [-1,1]"),
    ("fbm", Func::Fbm, "fbm(x, z, scale[, octaves]): fractal noise in [-1,1]"),
    ("ridged", Func::Ridged, "ridged(x, z, scale[, octaves]): ridged noise in [0,1]"),
    ("worley", Func::Worley, "worley(x, z, scale): cellular distance ~[0,1]"),
    ("rand", Func::Rand, "rand(x, z[, y]): hash in [0,1)"),
    ("height", Func::Height, "height(x, z): zone design heightfield"),
    ("edge", Func::Edge, "edge(x, z): distance to nearest zone border"),
    ("zone", Func::Zone, "zone(x, z): zone index or -1"),
    ("top", Func::Top, "top(x, z): current surface y before this edit"),
    ("dist", Func::Dist, "dist(x, z, x0, z0)"),
];

pub struct Ctx<'a> {
    pub zones: &'a Zones,
    pub seed: u32,
    pub top: Option<&'a (dyn Fn(i32, i32) -> f64 + Sync)>,
}

impl Expr {
    pub fn parse(src: &str) -> Result<Expr> {
        let toks = lex(src)?;
        let mut p = Parser { t: toks, i: 0 };
        let e = p.ternary()?;
        if p.i != p.t.len() {
            bail!("unexpected token {:?} in expression", p.t[p.i]);
        }
        Ok(e)
    }

    pub fn uses_y(&self) -> bool {
        match self {
            Expr::Y => true,
            Expr::Num(_) | Expr::X | Expr::Z => false,
            Expr::Neg(a) | Expr::Not(a) => a.uses_y(),
            Expr::Bin(_, a, b) => a.uses_y() || b.uses_y(),
            Expr::If(a, b, c) => a.uses_y() || b.uses_y() || c.uses_y(),
            Expr::Call(_, args) => args.iter().any(|a| a.uses_y()),
        }
    }

    pub fn eval(&self, x: f64, y: f64, z: f64, c: &Ctx) -> f64 {
        match self {
            Expr::Num(v) => *v,
            Expr::X => x,
            Expr::Y => y,
            Expr::Z => z,
            Expr::Neg(a) => -a.eval(x, y, z, c),
            Expr::Not(a) => b(a.eval(x, y, z, c) == 0.0),
            Expr::If(a, t, f) => {
                if a.eval(x, y, z, c) != 0.0 {
                    t.eval(x, y, z, c)
                } else {
                    f.eval(x, y, z, c)
                }
            }
            Expr::Bin(op, l, r) => {
                let a = l.eval(x, y, z, c);
                match op {
                    Op::And => return if a != 0.0 { b(r.eval(x, y, z, c) != 0.0) } else { 0.0 },
                    Op::Or => return if a != 0.0 { 1.0 } else { b(r.eval(x, y, z, c) != 0.0) },
                    _ => {}
                }
                let v = r.eval(x, y, z, c);
                match op {
                    Op::Add => a + v,
                    Op::Sub => a - v,
                    Op::Mul => a * v,
                    Op::Div => a / v,
                    Op::Mod => a.rem_euclid(v),
                    Op::Pow => a.powf(v),
                    Op::Lt => b(a < v),
                    Op::Le => b(a <= v),
                    Op::Gt => b(a > v),
                    Op::Ge => b(a >= v),
                    Op::Eq => b(a == v),
                    Op::Ne => b(a != v),
                    Op::And | Op::Or => unreachable!(),
                }
            }
            Expr::Call(f, args) => {
                let mut v = [0.0f64; 6];
                for (i, a) in args.iter().enumerate().take(6) {
                    v[i] = a.eval(x, y, z, c);
                }
                let n = args.len();
                match f {
                    Func::Abs => v[0].abs(),
                    Func::Min => v[..n].iter().cloned().fold(f64::MAX, f64::min),
                    Func::Max => v[..n].iter().cloned().fold(f64::MIN, f64::max),
                    Func::Floor => v[0].floor(),
                    Func::Ceil => v[0].ceil(),
                    Func::Round => v[0].round(),
                    Func::Sqrt => v[0].max(0.0).sqrt(),
                    Func::Pow => v[0].powf(v[1]),
                    Func::Sin => v[0].sin(),
                    Func::Cos => v[0].cos(),
                    Func::Tan => v[0].tan(),
                    Func::Atan2 => v[0].atan2(v[1]),
                    Func::Exp => v[0].exp(),
                    Func::Ln => v[0].ln(),
                    Func::Clamp => v[0].clamp(v[1].min(v[2]), v[2].max(v[1])),
                    Func::Lerp => v[0] + (v[1] - v[0]) * v[2],
                    Func::Smoothstep => {
                        let t = ((v[2] - v[0]) / (v[1] - v[0])).clamp(0.0, 1.0);
                        t * t * (3.0 - 2.0 * t)
                    }
                    Func::Step => b(v[1] >= v[0]),
                    Func::Noise => {
                        if n >= 4 {
                            let s = v[3].max(1e-6);
                            noise::perlin3(c.seed, v[0] / s, v[1] / s, v[2] / s)
                        } else {
                            let s = if n >= 3 { v[2] } else { 32.0 }.max(1e-6);
                            noise::perlin2(c.seed, v[0] / s, v[1] / s)
                        }
                    }
                    Func::Fbm => noise::fbm2(c.seed, v[0], v[1], if n >= 3 { v[2] } else { 100.0 }, if n >= 4 { v[3] as u32 } else { 5 }),
                    Func::Ridged => noise::ridged2(c.seed, v[0], v[1], if n >= 3 { v[2] } else { 100.0 }, if n >= 4 { v[3] as u32 } else { 5 }),
                    Func::Worley => noise::worley2(c.seed, v[0], v[1], if n >= 3 { v[2] } else { 64.0 }),
                    Func::Rand => {
                        let h = if n >= 3 {
                            noise::hash3(c.seed, v[0] as i32, v[2] as i32, v[1] as i32)
                        } else {
                            noise::hash2(c.seed, v[0] as i32, v[1] as i32)
                        };
                        noise::unit(h)
                    }
                    Func::Height => c.zones.design_height(v[0], v[1]),
                    Func::Edge => c.zones.edge_dist(v[0], v[1]),
                    Func::Zone => c.zones.zone_at(v[0], v[1]).map(|i| i as f64).unwrap_or(-1.0),
                    Func::Top => match c.top {
                        Some(t) => t(v[0].floor() as i32, v[1].floor() as i32),
                        None => 0.0,
                    },
                    Func::Dist => ((v[0] - v[2]).powi(2) + (v[1] - v[3]).powi(2)).sqrt(),
                }
            }
        }
    }

    /// If the expression is a conjunction of `y OP f(x,z)` terms, return the
    /// column bounds so it can be filled per column instead of per voxel.
    pub fn column_form(&self) -> Option<ColumnForm> {
        let mut terms = vec![];
        flatten_and(self, &mut terms);
        let mut cf = ColumnForm { lower: vec![], upper: vec![] };
        for t in terms {
            let Expr::Bin(op, l, r) = t else { return None };
            let (op, other) = match (&**l, &**r) {
                (Expr::Y, o) if !o.uses_y() => (*op, o.clone()),
                (o, Expr::Y) if !o.uses_y() => (flip(*op)?, o.clone()),
                _ => return None,
            };
            match op {
                // y <= e  -> y_max = floor(e); y < e -> y_max = ceil(e)-1
                Op::Le => cf.upper.push((other, true)),
                Op::Lt => cf.upper.push((other, false)),
                Op::Ge => cf.lower.push((other, true)),
                Op::Gt => cf.lower.push((other, false)),
                _ => return None,
            }
        }
        if cf.upper.is_empty() && cf.lower.is_empty() {
            return None;
        }
        Some(cf)
    }
}

pub struct ColumnForm {
    pub lower: Vec<(Expr, bool)>,
    pub upper: Vec<(Expr, bool)>,
}

impl ColumnForm {
    /// Inclusive integer y range for column (x, z), clamped to [lo, hi].
    pub fn range(&self, x: f64, z: f64, lo: i32, hi: i32, c: &Ctx) -> (i32, i32) {
        let mut a = lo;
        let mut b = hi;
        for (e, incl) in &self.upper {
            let v = e.eval(x, 0.0, z, c);
            let m = if *incl { v.floor() as i32 } else { v.ceil() as i32 - 1 };
            b = b.min(m);
        }
        for (e, incl) in &self.lower {
            let v = e.eval(x, 0.0, z, c);
            let m = if *incl { v.ceil() as i32 } else { v.floor() as i32 + 1 };
            a = a.max(m);
        }
        (a, b)
    }
}

fn flip(op: Op) -> Option<Op> {
    Some(match op {
        Op::Lt => Op::Gt,
        Op::Le => Op::Ge,
        Op::Gt => Op::Lt,
        Op::Ge => Op::Le,
        _ => return None,
    })
}

fn flatten_and<'a>(e: &'a Expr, out: &mut Vec<&'a Expr>) {
    if let Expr::Bin(Op::And, a, b) = e {
        flatten_and(a, out);
        flatten_and(b, out);
    } else {
        out.push(e);
    }
}

#[inline]
fn b(v: bool) -> f64 {
    if v {
        1.0
    } else {
        0.0
    }
}

// ---------------------------------------------------------------- lexer/parser

#[derive(Clone, Debug, PartialEq)]
enum Tok {
    Num(f64),
    Id(String),
    Sym(&'static str),
}

fn lex(s: &str) -> Result<Vec<Tok>> {
    let c: Vec<char> = s.chars().collect();
    let mut i = 0;
    let mut out = vec![];
    while i < c.len() {
        let ch = c[i];
        if ch.is_whitespace() {
            i += 1;
            continue;
        }
        if ch.is_ascii_digit() || (ch == '.' && i + 1 < c.len() && c[i + 1].is_ascii_digit()) {
            let st = i;
            while i < c.len() && (c[i].is_ascii_digit() || c[i] == '.') {
                i += 1;
            }
            if i < c.len() && (c[i] == 'e' || c[i] == 'E') && i + 1 < c.len() && (c[i + 1].is_ascii_digit() || c[i + 1] == '-') {
                i += 2;
                while i < c.len() && c[i].is_ascii_digit() {
                    i += 1;
                }
            }
            let t: String = c[st..i].iter().collect();
            out.push(Tok::Num(t.parse()?));
            continue;
        }
        if ch.is_alphabetic() || ch == '_' {
            let st = i;
            while i < c.len() && (c[i].is_alphanumeric() || c[i] == '_') {
                i += 1;
            }
            out.push(Tok::Id(c[st..i].iter().collect::<String>().to_lowercase()));
            continue;
        }
        let two: String = c[i..(i + 2).min(c.len())].iter().collect();
        let sym2 = ["<=", ">=", "==", "!=", "&&", "||"].iter().find(|&&s| s == two);
        if let Some(s) = sym2 {
            out.push(Tok::Sym(s));
            i += 2;
            continue;
        }
        let s: &'static str = match ch {
            '+' => "+",
            '-' => "-",
            '*' => "*",
            '/' => "/",
            '%' => "%",
            '^' => "^",
            '(' => "(",
            ')' => ")",
            ',' => ",",
            '<' => "<",
            '>' => ">",
            '!' => "!",
            '?' => "?",
            ':' => ":",
            '=' => "==",
            '≤' => "<=",
            '≥' => ">=",
            '≠' => "!=",
            _ => bail!("unexpected character '{ch}' in expression"),
        };
        out.push(Tok::Sym(s));
        i += 1;
    }
    Ok(out)
}

struct Parser {
    t: Vec<Tok>,
    i: usize,
}

impl Parser {
    fn peek_sym(&self, s: &str) -> bool {
        matches!(self.t.get(self.i), Some(Tok::Sym(x)) if *x == s)
    }
    fn eat(&mut self, s: &str) -> bool {
        if self.peek_sym(s) {
            self.i += 1;
            true
        } else {
            false
        }
    }
    fn expect(&mut self, s: &str) -> Result<()> {
        if !self.eat(s) {
            bail!("expected '{s}' in expression");
        }
        Ok(())
    }
    fn ternary(&mut self) -> Result<Expr> {
        let c = self.or()?;
        if self.eat("?") {
            let a = self.ternary()?;
            self.expect(":")?;
            let b = self.ternary()?;
            return Ok(Expr::If(Box::new(c), Box::new(a), Box::new(b)));
        }
        Ok(c)
    }
    fn or(&mut self) -> Result<Expr> {
        let mut l = self.and()?;
        while self.eat("||") {
            l = Expr::Bin(Op::Or, Box::new(l), Box::new(self.and()?));
        }
        Ok(l)
    }
    fn and(&mut self) -> Result<Expr> {
        let mut l = self.cmp()?;
        while self.eat("&&") {
            l = Expr::Bin(Op::And, Box::new(l), Box::new(self.cmp()?));
        }
        Ok(l)
    }
    fn cmp(&mut self) -> Result<Expr> {
        let l = self.add()?;
        for (s, op) in [("<=", Op::Le), (">=", Op::Ge), ("<", Op::Lt), (">", Op::Gt), ("==", Op::Eq), ("!=", Op::Ne)] {
            if self.eat(s) {
                return Ok(Expr::Bin(op, Box::new(l), Box::new(self.add()?)));
            }
        }
        Ok(l)
    }
    fn add(&mut self) -> Result<Expr> {
        let mut l = self.mul()?;
        loop {
            if self.eat("+") {
                l = Expr::Bin(Op::Add, Box::new(l), Box::new(self.mul()?));
            } else if self.eat("-") {
                l = Expr::Bin(Op::Sub, Box::new(l), Box::new(self.mul()?));
            } else {
                return Ok(l);
            }
        }
    }
    fn mul(&mut self) -> Result<Expr> {
        let mut l = self.unary()?;
        loop {
            if self.eat("*") {
                l = Expr::Bin(Op::Mul, Box::new(l), Box::new(self.unary()?));
            } else if self.eat("/") {
                l = Expr::Bin(Op::Div, Box::new(l), Box::new(self.unary()?));
            } else if self.eat("%") {
                l = Expr::Bin(Op::Mod, Box::new(l), Box::new(self.unary()?));
            } else {
                return Ok(l);
            }
        }
    }
    fn unary(&mut self) -> Result<Expr> {
        if self.eat("-") {
            return Ok(Expr::Neg(Box::new(self.unary()?)));
        }
        if self.eat("+") {
            return self.unary();
        }
        if self.eat("!") {
            return Ok(Expr::Not(Box::new(self.unary()?)));
        }
        self.pow()
    }
    fn pow(&mut self) -> Result<Expr> {
        let base = self.primary()?;
        if self.eat("^") {
            return Ok(Expr::Bin(Op::Pow, Box::new(base), Box::new(self.unary()?)));
        }
        Ok(base)
    }
    fn primary(&mut self) -> Result<Expr> {
        let t = self.t.get(self.i).cloned();
        self.i += 1;
        match t {
            Some(Tok::Num(v)) => Ok(Expr::Num(v)),
            Some(Tok::Sym("(")) => {
                let e = self.ternary()?;
                self.expect(")")?;
                Ok(e)
            }
            Some(Tok::Id(id)) => {
                if self.eat("(") {
                    let Some(&(_, f, _)) = FUNCS.iter().find(|(n, _, _)| *n == id) else {
                        bail!("unknown function '{id}'. Available: {}", FUNCS.iter().map(|f| f.0).collect::<Vec<_>>().join(", "));
                    };
                    let mut args = vec![];
                    if !self.eat(")") {
                        loop {
                            args.push(self.ternary()?);
                            if self.eat(")") {
                                break;
                            }
                            self.expect(",")?;
                        }
                    }
                    return Ok(Expr::Call(f, args));
                }
                match id.as_str() {
                    "x" => Ok(Expr::X),
                    "y" => Ok(Expr::Y),
                    "z" => Ok(Expr::Z),
                    "pi" => Ok(Expr::Num(std::f64::consts::PI)),
                    "e" => Ok(Expr::Num(std::f64::consts::E)),
                    "true" => Ok(Expr::Num(1.0)),
                    "false" => Ok(Expr::Num(0.0)),
                    _ => bail!("unknown variable '{id}' (use x, y, z)"),
                }
            }
            other => bail!("unexpected {:?} in expression", other),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn ev(s: &str) -> f64 {
        let z = Zones::default();
        let c = Ctx { zones: &z, seed: 1, top: None };
        Expr::parse(s).unwrap().eval(2.0, 3.0, 4.0, &c)
    }
    #[test]
    fn arithmetic() {
        assert_eq!(ev("1 + 2 * 3"), 7.0);
        assert_eq!(ev("-2 ^ 2"), -4.0);
        assert_eq!(ev("x * y + z"), 10.0);
        assert_eq!(ev("y <= 3 && x > 1"), 1.0);
        assert_eq!(ev("y ≤ 2 ? 5 : 6"), 6.0);
        assert_eq!(ev("max(1, x, 9, z)"), 9.0);
        assert_eq!(ev("clamp(15, 0, 10)"), 10.0);
    }
    #[test]
    fn column() {
        let e = Expr::parse("y <= height(x, z) && y > 10").unwrap();
        let cf = e.column_form().unwrap();
        let z = Zones::default();
        let c = Ctx { zones: &z, seed: 1, top: None };
        let (a, b) = cf.range(0.0, 0.0, -64, 319, &c);
        assert_eq!(a, 11);
        assert!(b > 30 && b < 100);
        assert!(Expr::parse("noise(x,y,z,10) > 0").unwrap().column_form().is_none());
        let e = Expr::parse("70 > y").unwrap();
        assert_eq!(e.column_form().unwrap().range(0.0, 0.0, -64, 319, &c), (-64, 69));
    }
}
