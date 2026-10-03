//! Canonical v1 fixed-width encoding and SHA-256 hashing from SPEC.md.
//! Encoding does not establish authorization, deployment validity, or execution.

use solana_sha256_hasher::hash;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Domain {
    pub source_domain: [u8; 32],
    pub destination_domain: [u8; 32],
    pub solana_program: [u8; 32],
    /// The complete uint256 chain ID, already represented in big-endian bytes.
    pub chain_id: [u8; 32],
    pub settlement: [u8; 20],
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Identity {
    pub domain: Domain,
    pub user: [u8; 32],
    pub nonce: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Terms {
    pub identity: Identity,
    pub market: [u8; 32],
    pub outcome: u8,
    pub cash_amount: u64,
    pub minimum_shares: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Receipt {
    pub terms_hash: [u8; 32],
    pub terminal: u8,
    pub filled_quantity: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EncodingError {
    InvalidTerminal(u8),
}

/// Encode the 196-byte identity preimage, with an eight-byte big-endian nonce.
pub fn identity_bytes(identity: &Identity) -> [u8; 196] {
    let mut bytes = [0; 196];
    bytes[..8].copy_from_slice(b"CCSLID01");
    bytes[8..156].copy_from_slice(&domain_bytes(&identity.domain));
    bytes[156..188].copy_from_slice(&identity.user);
    bytes[188..196].copy_from_slice(&identity.nonce.to_be_bytes());
    bytes
}

pub fn order_id(identity: &Identity) -> [u8; 32] {
    hash(&identity_bytes(identity)).to_bytes()
}

/// Encode the 277-byte terms preimage, including the derived order ID.
/// Amount, outcome, and nonce policies belong to the business logic.
pub fn terms_bytes(terms: &Terms) -> [u8; 277] {
    let mut bytes = [0; 277];
    bytes[..8].copy_from_slice(b"CCSLTR01");
    bytes[8..156].copy_from_slice(&domain_bytes(&terms.identity.domain));
    bytes[156..188].copy_from_slice(&order_id(&terms.identity));
    bytes[188..220].copy_from_slice(&terms.identity.user);
    bytes[220..228].copy_from_slice(&terms.identity.nonce.to_be_bytes());
    bytes[228..260].copy_from_slice(&terms.market);
    bytes[260] = terms.outcome;
    bytes[261..269].copy_from_slice(&terms.cash_amount.to_be_bytes());
    bytes[269..277].copy_from_slice(&terms.minimum_shares.to_be_bytes());
    bytes
}

pub fn terms_hash(terms: &Terms) -> [u8; 32] {
    hash(&terms_bytes(terms)).to_bytes()
}

/// Encode the 49-byte receipt preimage for Filled (1) or Cancelled (2).
/// Quantity, its relation to terms, and execution are not validated here.
pub fn receipt_bytes(receipt: &Receipt) -> Result<[u8; 49], EncodingError> {
    if receipt.terminal != 1 && receipt.terminal != 2 {
        return Err(EncodingError::InvalidTerminal(receipt.terminal));
    }

    let mut bytes = [0; 49];
    bytes[..8].copy_from_slice(b"CCSLRC01");
    bytes[8..40].copy_from_slice(&receipt.terms_hash);
    bytes[40] = receipt.terminal;
    bytes[41..49].copy_from_slice(&receipt.filled_quantity.to_be_bytes());
    Ok(bytes)
}

pub fn receipt_hash(receipt: &Receipt) -> Result<[u8; 32], EncodingError> {
    Ok(hash(&receipt_bytes(receipt)?).to_bytes())
}

/// Raw 148-byte domain block, without ABI word padding or integer narrowing.
fn domain_bytes(domain: &Domain) -> [u8; 148] {
    let mut bytes = [0; 148];
    bytes[..32].copy_from_slice(&domain.source_domain);
    bytes[32..64].copy_from_slice(&domain.destination_domain);
    bytes[64..96].copy_from_slice(&domain.solana_program);
    bytes[96..128].copy_from_slice(&domain.chain_id);
    bytes[128..148].copy_from_slice(&domain.settlement);
    bytes
}
