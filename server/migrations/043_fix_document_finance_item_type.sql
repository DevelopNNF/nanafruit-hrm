-- ค่าเอกสาร was seeded in 042 as a deduction, on the reading that it was a
-- document fee recovered from wages. It is the opposite: the company pays it
-- to the employee for preparing documents, so it is income.
--
-- 042 was corrected too, which fixes fresh installs — but the runner records
-- an applied file and skips it forever, so every database that already ran
-- 042 still holds the wrong value. That is what this file is for. (See the
-- README: never re-edit an applied migration and expect it to take; add a
-- numbered file.)
--
-- Guarded on the current value rather than a blind UPDATE: if HR has already
-- corrected this row by hand, or repurposed the code for something they do
-- deduct, this leaves their decision alone.

UPDATE master_finance_items
SET item_type   = 'income',
    description = 'ค่าตอบแทนการจัดทำเอกสารที่บริษัทจ่ายให้พนักงาน',
    updated_at  = now()
WHERE item_code = 'DOCUMENT'
  AND item_type = 'deduction';
