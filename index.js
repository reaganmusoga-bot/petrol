/**
 * PetroManager Pro — Cloud Functions stubs (v1.3)
 *
 * Deploy (from this folder after `npm init` + firebase tools):
 *   npm install firebase-functions firebase-admin
 *   firebase deploy --only functions
 *
 * These run SERVER-SIDE so sale/reverse/offload cannot be faked from the browser.
 * Wire the client later: call httpsCallable('completeSale') instead of local transaction.
 */

const functions = require('firebase-functions');
const admin = require('firebase-admin');
admin.initializeApp();
const db = admin.firestore();

function requireAuth(context) {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Sign in required');
  }
  return context.auth.uid;
}

/** Example: complete a sale atomically on the server */
exports.completeSale = functions.https.onCall(async (data, context) => {
  requireAuth(context);
  const { companyId, stationId, cart, payment, customerId, grandTotal, transactionId } = data || {};
  if (!companyId || !stationId || !cart || !cart.length) {
    throw new functions.https.HttpsError('invalid-argument', 'Missing sale payload');
  }

  return db.runTransaction(async (tx) => {
    // 1) Read all inventory docs first
    const invSnaps = [];
    for (const item of cart) {
      const id = `${companyId}_${stationId}_${item.product}`;
      const ref = db.collection('inventory').doc(id);
      const snap = await tx.get(ref);
      invSnaps.push({ item, ref, snap });
    }

    // 2) Validate stock
    for (const row of invSnaps) {
      const qty = row.snap.exists ? (row.snap.data().quantity || 0) : 0;
      if (qty < row.item.qty) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          `Insufficient ${row.item.product}. Available: ${qty}`
        );
      }
    }

    // 3) Writes: stock, sales, optional AR
    for (const row of invSnaps) {
      const dataInv = row.snap.data() || {};
      const newQty = (dataInv.quantity || 0) - row.item.qty;
      tx.set(row.ref, {
        ...dataInv,
        quantity: newQty,
        companyId,
        station_id: String(stationId),
        product_type: row.item.product,
        last_updated: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    }

    const saleRef = db.collection('sales').doc();
    tx.set(saleRef, {
      companyId,
      station_id: String(stationId),
      amount: grandTotal,
      payment_method: payment || 'cash',
      customer_id: customerId || null,
      transaction_id: transactionId || saleRef.id,
      status: 'completed',
      created_at: admin.firestore.FieldValue.serverTimestamp()
    });

    if (payment === 'credit' && customerId) {
      const custRef = db.collection('customers').doc(String(customerId));
      const custSnap = await tx.get(custRef);
      if (custSnap.exists) {
        const bal = Number(custSnap.data().current_balance || 0) + Number(grandTotal || 0);
        tx.update(custRef, { current_balance: bal });
      }
    }

    return { ok: true, saleId: saleRef.id };
  });
});

/** Example: reverse sale */
exports.reverseSale = functions.https.onCall(async (data, context) => {
  requireAuth(context);
  const { saleId, companyId } = data || {};
  if (!saleId) throw new functions.https.HttpsError('invalid-argument', 'saleId required');

  return db.runTransaction(async (tx) => {
    const saleRef = db.collection('sales').doc(saleId);
    const saleSnap = await tx.get(saleRef);
    if (!saleSnap.exists) throw new functions.https.HttpsError('not-found', 'Sale not found');
    const sale = saleSnap.data();
    if (sale.status === 'reversed') {
      throw new functions.https.HttpsError('failed-precondition', 'Already reversed');
    }
    // Restore stock (simplified single-line sale)
    const invId = `${companyId || sale.companyId}_${sale.station_id}_${sale.product_type}`;
    const invRef = db.collection('inventory').doc(invId);
    const invSnap = await tx.get(invRef);
    const qty = invSnap.exists ? (invSnap.data().quantity || 0) : 0;
    tx.set(invRef, {
      quantity: qty + (Number(sale.quantity) || 0),
      companyId: companyId || sale.companyId,
      station_id: String(sale.station_id),
      product_type: sale.product_type,
      last_updated: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    tx.update(saleRef, {
      status: 'reversed',
      reversed_at: admin.firestore.FieldValue.serverTimestamp()
    });
    return { ok: true };
  });
});

/** Health check */
exports.ping = functions.https.onCall(async () => ({ ok: true, service: 'PetroManager Pro Functions' }));
