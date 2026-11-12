//! Writes implementation documents for tests. The JSON compiler replaces this when it exists.

use bytemuck::{bytes_of, cast_slice, Pod};

use crate::{
    AccountSourceKind, AccountV1, Address, AppliesV1, DocumentHeaderV1, DocumentKind, Encoding, ImplementationDocV1,
    InstructionV1, LiteralV1, OutputBindingV1, PodU16, PoolRefV1, PostConditionV1, RangeV1, RecipeKind,
    SegmentSourceKind, SegmentV1, TableRefV1, MAGIC, SPEC_MAJOR, SPEC_MINOR,
};

const WRITABLE: u8 = 1;
const SIGNER: u8 = 2;

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
    pool: Vec<u8>,
}

impl Fixture {
    fn empty(recipe: RecipeKind) -> Self {
        Self {
            recipe,
            name: PoolRefV1::default(),
            message: PoolRefV1::default(),
            url: PoolRefV1::default(),
            applies: Vec::new(),
            post_conditions: Vec::new(),
            addresses: Vec::new(),
            accounts: Vec::new(),
            seeds: Vec::new(),
            instructions: Vec::new(),
            instruction_accounts: Vec::new(),
            segments: Vec::new(),
            output_bindings: Vec::new(),
            literals: Vec::new(),
            pool: Vec::new(),
        }
    }

    /// The static record for a SOL transfer: `from` pays `amount` lamports to `to`.
    pub(crate) fn system_transfer() -> Self {
        let mut fixture = Self::empty(RecipeKind::Static);
        fixture.name = fixture.text(b"system-transfer");
        fixture.message = fixture.text(b"transfer {i3} lamports from {i0} to {i1}");

        let from = fixture.text(b"from");
        let to = fixture.text(b"to");
        let system_program = fixture.text(b"systemProgram");
        fixture.addresses = vec![Address::default()];
        fixture.accounts = vec![
            account(from, WRITABLE | SIGNER, AccountSourceKind::Value, [1, 0, 0, 0, 0, 0]),
            account(to, WRITABLE, AccountSourceKind::Value, [1, 1, 0, 0, 0, 0]),
            account(system_program, 0, AccountSourceKind::Static, [0; 6]),
        ];

        let discriminator = fixture.text(&[2, 0, 0, 0]);
        fixture.segments = vec![
            segment(SegmentSourceKind::Literal, 0, pool_payload(discriminator)),
            segment(SegmentSourceKind::Reference, Encoding::U64Le.into(), [1, 3, 0, 0, 0, 0]),
        ];
        fixture.instruction_accounts = vec![0, 1];
        fixture.instructions = vec![InstructionV1 {
            program: 2,
            accounts: RangeV1 { first: 0, count: 2 },
            segments: RangeV1 { first: 0, count: 2 },
        }];

        fixture
    }

    pub(crate) fn text(&mut self, bytes: &[u8]) -> PoolRefV1 {
        let reference = PoolRefV1 { offset: pod_len(self.pool.len()), len: pod_len(bytes.len()) };
        self.pool.extend_from_slice(bytes);

        reference
    }

    /// Lays out the fixed part, then each table in the order of the fixed part, then the pool.
    pub(crate) fn build(&self) -> Vec<u8> {
        let mut bytes = vec![0; core::mem::size_of::<ImplementationDocV1>()];

        let applies = append(&mut bytes, &self.applies);
        let post_conditions = append(&mut bytes, &self.post_conditions);
        let addresses = append(&mut bytes, &self.addresses);
        let accounts = append(&mut bytes, &self.accounts);
        let seeds = append(&mut bytes, &self.seeds);
        let instructions = append(&mut bytes, &self.instructions);
        let instruction_accounts = append(&mut bytes, &self.instruction_accounts);
        let segments = append(&mut bytes, &self.segments);
        let output_bindings = append(&mut bytes, &self.output_bindings);
        let literals = append(&mut bytes, &self.literals);
        let pool = PoolRefV1 { offset: pod_len(bytes.len()), len: pod_len(self.pool.len()) };
        bytes.extend_from_slice(&self.pool);

        let fixed = ImplementationDocV1 {
            header: DocumentHeaderV1 {
                magic: MAGIC,
                spec_major: SPEC_MAJOR,
                spec_minor: SPEC_MINOR,
                kind: DocumentKind::Implementation.into(),
                body_len: pod_len(bytes.len().checked_sub(DocumentHeaderV1::LEN).unwrap()),
                extension_len: PodU16::new(0),
            },
            recipe_kind: self.recipe.into(),
            name: self.name,
            message: self.message,
            url: self.url,
            applies,
            post_conditions,
            addresses,
            accounts,
            seeds,
            instructions,
            instruction_accounts,
            segments,
            output_bindings,
            literals,
            pool,
            ..ImplementationDocV1::default()
        };
        bytes.get_mut(..core::mem::size_of::<ImplementationDocV1>()).unwrap().copy_from_slice(bytes_of(&fixed));

        bytes
    }
}

fn append<T: Pod>(bytes: &mut Vec<u8>, entries: &[T]) -> TableRefV1 {
    let table = TableRefV1 { offset: pod_len(bytes.len()), count: u8::try_from(entries.len()).unwrap() };
    bytes.extend_from_slice(cast_slice(entries));

    table
}

fn account(name: PoolRefV1, flags: u8, source: AccountSourceKind, payload: [u8; 6]) -> AccountV1 {
    AccountV1 { name, flags, source: source.into(), payload }
}

fn segment(source: SegmentSourceKind, encoding: u8, payload: [u8; 6]) -> SegmentV1 {
    SegmentV1 { source: source.into(), encoding, payload }
}

fn pool_payload(range: PoolRefV1) -> [u8; 6] {
    let [a, b] = range.offset.0;
    let [c, d] = range.len.0;

    [a, b, c, d, 0, 0]
}

fn pod_len(len: usize) -> PodU16 {
    PodU16::new(u16::try_from(len).unwrap())
}
