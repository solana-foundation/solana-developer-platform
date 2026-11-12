//! Writes documents for tests. The compiler crate is the real writer. The spec crate cannot depend
//! on it, so these fixtures lay out the same bytes by hand.

use bytemuck::{bytes_of, cast_slice, Pod};

use crate::{
    AccountSourceKind, AccountV1, Address, AppliesV1, CheckKind, DocumentHeaderV1, DocumentKind, Encoding,
    ImplementationDocV1, InputV1, InstructionV1, InterfaceDocV1, LiteralV1, OutputBindingV1, OutputV1, PodU16,
    PoolRefV1, PostConditionV1, RangeV1, RecipeKind, SegmentSourceKind, SegmentV1, TableRefV1, ValueRefV1, MAGIC,
    SPEC_MAJOR, SPEC_MINOR,
};

const WRITABLE: u8 = 1;
const SIGNER: u8 = 2;
const INPUT: u8 = 1;

/// A byte pool that fixtures add text to.
#[derive(Default)]
pub(crate) struct Pool {
    bytes: Vec<u8>,
}

impl Pool {
    pub(crate) fn text(&mut self, bytes: &[u8]) -> PoolRefV1 {
        let reference = PoolRefV1 { offset: pod_len(self.bytes.len()), len: pod_len(bytes.len()) };
        self.bytes.extend_from_slice(bytes);

        reference
    }
}

pub(crate) struct Fixture {
    pub(crate) recipe: RecipeKind,
    pub(crate) name: PoolRefV1,
    pub(crate) message: PoolRefV1,
    pub(crate) url: PoolRefV1,
    pub(crate) applies: Vec<AppliesV1>,
    pub(crate) post_conditions: Vec<PostConditionV1>,
    pub(crate) addresses: Vec<Address>,
    pub(crate) accounts: Vec<AccountV1>,
    pub(crate) seeds: Vec<SegmentV1>,
    pub(crate) instructions: Vec<InstructionV1>,
    pub(crate) instruction_accounts: Vec<u8>,
    pub(crate) segments: Vec<SegmentV1>,
    pub(crate) output_bindings: Vec<OutputBindingV1>,
    pub(crate) literals: Vec<LiteralV1>,
    pool: Pool,
}

impl Fixture {
    /// The static record for a SOL transfer: `from` pays `amount` lamports to `to`.
    pub(crate) fn system_transfer() -> Self {
        let mut pool = Pool::default();
        let name = pool.text(b"system-transfer");
        let message = pool.text(b"transfer {i3} lamports from {i0} to {i1}");
        let accounts = vec![
            account(pool.text(b"from"), WRITABLE | SIGNER, AccountSourceKind::Value, [INPUT, 0, 0, 0, 0, 0]),
            account(pool.text(b"to"), WRITABLE, AccountSourceKind::Value, [INPUT, 1, 0, 0, 0, 0]),
            account(pool.text(b"systemProgram"), 0, AccountSourceKind::Static, [0; 6]),
        ];
        let discriminator = pool.text(&[2, 0, 0, 0]);
        let segments = vec![
            segment(SegmentSourceKind::Literal, 0, pool_payload(discriminator)),
            segment(SegmentSourceKind::Reference, Encoding::U64Le.into(), [INPUT, 3, 0, 0, 0, 0]),
        ];

        Self {
            recipe: RecipeKind::Static,
            name,
            message,
            url: PoolRefV1::default(),
            applies: Vec::new(),
            post_conditions: Vec::new(),
            addresses: vec![Address::default()],
            accounts,
            seeds: Vec::new(),
            instructions: vec![InstructionV1 {
                program: 2,
                accounts: RangeV1 { first: 0, count: 2 },
                segments: RangeV1 { first: 0, count: 2 },
            }],
            instruction_accounts: vec![0, 1],
            segments,
            output_bindings: Vec::new(),
            literals: Vec::new(),
            pool,
        }
    }

    pub(crate) fn text(&mut self, bytes: &[u8]) -> PoolRefV1 {
        self.pool.text(bytes)
    }

    pub(crate) fn build(&self) -> Vec<u8> {
        let mut writer = Writer::new(core::mem::size_of::<ImplementationDocV1>());

        let fixed = ImplementationDocV1 {
            recipe_kind: self.recipe.into(),
            name: self.name,
            message: self.message,
            url: self.url,
            applies: writer.table(&self.applies),
            post_conditions: writer.table(&self.post_conditions),
            addresses: writer.table(&self.addresses),
            accounts: writer.table(&self.accounts),
            seeds: writer.table(&self.seeds),
            instructions: writer.table(&self.instructions),
            instruction_accounts: writer.table(&self.instruction_accounts),
            segments: writer.table(&self.segments),
            output_bindings: writer.table(&self.output_bindings),
            literals: writer.table(&self.literals),
            pool: writer.pool(&self.pool),
            ..ImplementationDocV1::default()
        };
        let header = writer.header(DocumentKind::Implementation);

        writer.finish(&ImplementationDocV1 { header, ..fixed })
    }
}

pub(crate) struct InterfaceFixture {
    pub(crate) inputs: Vec<InputV1>,
    pub(crate) outputs: Vec<OutputV1>,
    pub(crate) post_conditions: Vec<PostConditionV1>,
    name: PoolRefV1,
    display: PoolRefV1,
    pool: Pool,
}

impl InterfaceFixture {
    /// `token.transfer`: `from`, `to`, `mint`, `amount` displayed in units of `mint`, and an
    /// optional `memo`.
    pub(crate) fn token_transfer() -> Self {
        let mut pool = Pool::default();
        let name = pool.text(b"token.transfer");
        let display = pool.text(b"Send {i3} {i2} to {i1}");
        let none = ValueRefV1::default();
        let inputs = vec![
            input(pool.text(b"from"), 12, 1, none),
            input(pool.text(b"to"), 12, 0, none),
            input(pool.text(b"mint"), 13, 0, none),
            input(pool.text(b"amount"), 4, 0, ValueRefV1 { source: INPUT, index: 2 }),
            input(pool.text(b"memo"), 14, 2, none),
        ];
        let post_conditions = vec![
            PostConditionV1 {
                check: CheckKind::Outflow.into(),
                args: [
                    ValueRefV1 { source: INPUT, index: 0 },
                    ValueRefV1 { source: INPUT, index: 2 },
                    ValueRefV1 { source: INPUT, index: 3 },
                ],
                programs: RangeV1::default(),
                message: pool.text(b"{i0} sends at most {i3} of {i2}"),
            },
            PostConditionV1 {
                check: CheckKind::NoOtherOutflows.into(),
                args: [ValueRefV1 { source: INPUT, index: 0 }, none, none],
                programs: RangeV1::default(),
                message: pool.text(b"nothing else leaves {i0}"),
            },
        ];

        Self { inputs, outputs: Vec::new(), post_conditions, name, display, pool }
    }

    pub(crate) fn build(&self) -> Vec<u8> {
        let mut writer = Writer::new(core::mem::size_of::<InterfaceDocV1>());

        let fixed = InterfaceDocV1 {
            name: self.name,
            display: self.display,
            inputs: writer.table(&self.inputs),
            outputs: writer.table(&self.outputs),
            post_conditions: writer.table(&self.post_conditions),
            addresses: writer.table::<Address>(&[]),
            literals: writer.table::<LiteralV1>(&[]),
            pool: writer.pool(&self.pool),
            ..InterfaceDocV1::default()
        };
        let header = writer.header(DocumentKind::Interface);

        writer.finish(&InterfaceDocV1 { header, ..fixed })
    }
}

/// Lays out a fixed part, then each table in the order that the fixture adds it, then the pool.
struct Writer {
    bytes: Vec<u8>,
    fixed_len: usize,
}

impl Writer {
    fn new(fixed_len: usize) -> Self {
        Self { bytes: vec![0; fixed_len], fixed_len }
    }

    fn table<T: Pod>(&mut self, entries: &[T]) -> TableRefV1 {
        let table = TableRefV1 { offset: pod_len(self.bytes.len()), count: u8::try_from(entries.len()).unwrap() };
        self.bytes.extend_from_slice(cast_slice(entries));

        table
    }

    fn pool(&mut self, pool: &Pool) -> PoolRefV1 {
        let range = PoolRefV1 { offset: pod_len(self.bytes.len()), len: pod_len(pool.bytes.len()) };
        self.bytes.extend_from_slice(&pool.bytes);

        range
    }

    fn header(&self, kind: DocumentKind) -> DocumentHeaderV1 {
        DocumentHeaderV1 {
            magic: MAGIC,
            spec_major: SPEC_MAJOR,
            spec_minor: SPEC_MINOR,
            kind: kind.into(),
            body_len: pod_len(self.bytes.len().checked_sub(DocumentHeaderV1::LEN).unwrap()),
            extension_len: PodU16::new(0),
        }
    }

    fn finish<T: Pod>(mut self, fixed: &T) -> Vec<u8> {
        self.bytes.get_mut(..self.fixed_len).unwrap().copy_from_slice(bytes_of(fixed));

        self.bytes
    }
}

fn account(name: PoolRefV1, flags: u8, source: AccountSourceKind, payload: [u8; 6]) -> AccountV1 {
    AccountV1 { name, flags, source: source.into(), payload }
}

fn segment(source: SegmentSourceKind, encoding: u8, payload: [u8; 6]) -> SegmentV1 {
    SegmentV1 { source: source.into(), encoding, payload }
}

fn input(name: PoolRefV1, value_type: u8, flags: u8, amount_mint: ValueRefV1) -> InputV1 {
    InputV1 { name, value_type, flags, amount_mint }
}

fn pool_payload(range: PoolRefV1) -> [u8; 6] {
    let [a, b] = range.offset.0;
    let [c, d] = range.len.0;

    [a, b, c, d, 0, 0]
}

fn pod_len(len: usize) -> PodU16 {
    PodU16::new(u16::try_from(len).unwrap())
}
