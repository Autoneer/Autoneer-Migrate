-- MySQL schema

-- drop database if exists (optional)
-- drop database if exists autoneer;
create database autoneer default character set utf8mb4 collate utf8mb4_general_ci;
use autoneer;

-- tables

create table acc_class (
    classid int auto_increment primary key,
    description varchar(100),
    accclass int,
    accounttype varchar(10)
);

create table acc_department (
    accdid int auto_increment primary key,
    description varchar(100),
    accnr int,
    accclass int,
    deptnr int,
    accountgroup varchar(50),
    depttype varchar(20)
);

create table account_links (
    linkid int auto_increment primary key,
    paymethod varchar(50),
    accnr int
);

create table accounts (
    aid int auto_increment primary key,
    status varchar(10),
    accnr int,
    description varchar(100),
    acctype varchar(20),
    accclass int,
    startbalance decimal(18,2) default 0.00,
    accounttotal decimal(18,2) default 0.00,
    dorecon varchar(3),
    bankname varchar(50),
    branchname varchar(50),
    branchcode varchar(20),
    baccnr int,
    bacctype varchar(20),
    lastystartbalance decimal(18,2) default 0.00,
    lastyearcurrentbalance decimal(18,2) default 0.00,
    accountgroup varchar(50),
    accounttype varchar(10),
    credit decimal(18,2) default 0.00,
    currentbalancedebit decimal(18,2) default 0.00,
    debit decimal(18,2) default 0.00,
    financialcategory varchar(50),
    department int,
    company int,
    mtd decimal(18,2) default 0.00,
    ytd decimal(18,2) default 0.00,
    paccnr int
);

-- General Ledger (GL) tables (see migrations/001_gl_core.js)

create table gl_account_types (
    id int auto_increment primary key,
    code varchar(20) not null,
    statement_section enum('BalanceSheet','IncomeStatement') not null,
    display_order int default 0,
    created_at timestamp default current_timestamp,
    unique key uk_gl_account_types_code (code)
);

create table gl_accounts (
    id int auto_increment primary key,
    accnr int not null,
    name varchar(150) not null,
    type_id int not null,
    category varchar(100) default null,
    statement_group varchar(100) default null,
    parent_accnr int default null,
    active tinyint(1) default 1,
    tax_reporting_code varchar(50) default null,
    created_at timestamp default current_timestamp,
    updated_at timestamp null default null on update current_timestamp,
    unique key uk_gl_accounts_accnr (accnr),
    index idx_gl_accounts_type (type_id),
    constraint fk_gl_accounts_type foreign key (type_id) references gl_account_types(id)
);

create table gl_periods (
    id int auto_increment primary key,
    fiscal_year int not null,
    period_no int not null,
    start_date date not null,
    end_date date not null,
    status enum('OPEN','CLOSED') not null default 'OPEN',
    locked_by int default null,
    locked_at timestamp null default null,
    unique key uk_gl_periods_range (start_date, end_date),
    index idx_gl_periods_status (status),
    index idx_gl_periods_year (fiscal_year, period_no)
);

create table gl_journal_headers (
    id bigint auto_increment primary key,
    jdate date not null,
    source varchar(50) not null,
    source_id varchar(50) not null,
    description varchar(255) default null,
    status enum('DRAFT','POSTED') not null default 'POSTED',
    period_id int not null,
    posted_by int default null,
    posted_at timestamp null default current_timestamp,
    created_at timestamp default current_timestamp,
    updated_at timestamp null default null on update current_timestamp,
    unique key uk_gl_journal_headers_source (source, source_id),
    index idx_gl_journal_headers_date (jdate),
    index idx_gl_journal_headers_period (period_id),
    index idx_gl_journal_headers_status (status),
    constraint fk_gl_journal_headers_period foreign key (period_id) references gl_periods(id)
);

create table tax_codes (
    id int auto_increment primary key,
    code varchar(20) not null,
    description varchar(150) not null,
    rate decimal(5,2) not null default 0.00,
    input_output enum('INPUT','OUTPUT','NONE') not null default 'NONE',
    created_at timestamp default current_timestamp,
    unique key uk_tax_codes_code (code)
);

create table gl_journal_lines (
    id bigint auto_increment primary key,
    header_id bigint not null,
    accnr int not null,
    debit decimal(18,2) not null default 0.00,
    credit decimal(18,2) not null default 0.00,
    tax_code_id int default null,
    ref1 varchar(100) default null,
    ref2 varchar(100) default null,
    cid int default null,
    suppid int default null,
    job_number int default null,
    invoice_nr int default null,
    line_no int default null,
    created_at timestamp default current_timestamp,
    index idx_gl_journal_lines_accnr (accnr),
    index idx_gl_journal_lines_header (header_id),
    constraint fk_gl_journal_lines_header foreign key (header_id) references gl_journal_headers(id) on delete cascade,
    constraint fk_gl_journal_lines_accnr foreign key (accnr) references gl_accounts(accnr),
    constraint fk_gl_journal_lines_tax foreign key (tax_code_id) references tax_codes(id)
);

create table acc_range (
    rangeid int auto_increment primary key,
    accclass int,
    startacc int,
    endacc int,
    description varchar(50)
);

create table adjust_stock (
	adjust_id int auto_increment primary key,
    stock_id int not null,
    description varchar(50),
    part_nr varchar(70),
    quantity decimal(9,2),
    reason varchar(100),
    adjust_date date,
    staff_id int,
    siid int,
    cost_price decimal(18,2) default 0.00,
    salesprice decimal(18,2) default 0.00,
    adjusttype varchar(10)
);

create table banks (
    bankid int auto_increment primary key,
    bankname varchar(100),
    branchcode varchar(15),
    accountnr varchar(15),
    address varchar(254),
    vatnr varchar(15),
    contact varchar(30),
    telnr varchar(30),
    email varchar(50),
    dealercode varchar(20)
);

create table bank_statements (
    bsid int auto_increment primary key,
    statementdate date,
    trxdate date,
    statementnr varchar(50),
    description varchar(200),
    reconid int,
    sourceid int,
    debitamount decimal(18,2) default 0.00,
    creditamount decimal(18,2) default 0.00,
    source varchar(50),
    status varchar(30)
);

create table bookings (
    bid int auto_increment primary key,
    cid int,
    staff_id int,
    job_number int,
    bookstart timestamp,
    bookend timestamp,
    notes varchar(245),
    jobtype varchar(30),
    status varchar(50),
	technician_id int
);

create table book_logon_detail (
    logonid int auto_increment primary key,
    baseurl varchar(70),
    apikey varchar(50),
    companyid varchar(100),
    username varchar(50),
    `password` varchar(50)
);

create table book_sync (
    bsyncid int auto_increment primary key,
    syncdate date,
    status varchar(50),
    cid int,
    job_number int
);

create table cash_customer (
    ccid int auto_increment primary key,
    name varchar(150),
    address varchar(254),
    vatnr varchar(50),
    job_number int,
    invoice_nr int,
    telnr varchar(30),
    email varchar(100),
    quotenr int,
    contactperson varchar(50)
);

create table categories (
    cgid int auto_increment primary key,
    description varchar(50)
);

create table credit_notes (
    cnid int auto_increment primary key,
    invoice_nr varchar(20),
    staff_id int,
    comment varchar(254),
    cdate date,
    siid int,
    amount decimal(18,2) default 0.00,
    item_id int,
    quantity decimal(9,2),
    ctype varchar(50),
    cid int,
    status varchar(20),
    description varchar(254),
    returnstock varchar(3),
    job_number int,
    itemtype varchar(20),
    debitaccount varchar(8)
);

create table credit_notes_supplier (
    cnoteid int auto_increment primary key,
    status varchar(30),
    staff_id int,
    cnotetype varchar(50),
    cnotedate date not null,
    sinvid int,
    invoice_nr varchar(40),
    vat decimal(18,2) default 0.00,
    amount decimal(18,2) default 0.00,
    suppid int,
    acc int,
    comments varchar(250)
);

create table company (
    company_id int auto_increment primary key,
    company_name varchar(100) not null,
    address_1 varchar(100),
    address_2 varchar(100),
    address_3 varchar(100),
    address_4 varchar(50),
    address_code varchar(10),
    telnr varchar(50),
    faxnr varchar(50),
    email varchar(50),
    mobile varchar(50),
    vatnr varchar(50),
    web_address varchar(100),
    post1 varchar(100),
    post2 varchar(100),
    post3 varchar(100),
    post_code varchar(10),
    licensenr varchar(100),
    smsmobile varchar(20),
    beestatus varchar(15),
    csdno varchar(15),
	notes varchar(500)
);

create table company_prefferences (
	id int auto_increment primary key,
    guarantee_time varchar(10),
    autobankcheques varchar(4),
    autosundries varchar(4),
    tearoff varchar(3),
    receiptprinter varchar(3),
    sundryamount decimal(18,2) default 0.00,
    printhours varchar(3),
    printinvoiceheader varchar(3),
    sendfinalisesms varchar(3),
    taxpercent decimal(18,2) default 0.00,
    taxlabel varchar(5),
    fiscalyear date,
    unittype varchar(20),
    showvat varchar(3),
    candopos varchar(3),
    strict varchar(3),
    signpdf varchar(3),
    sundrypercent int,
    sundrydescriptiion varchar(50),
    stocklog varchar(5)
);

create table onboarding_state (
    id int auto_increment primary key,
    completed tinyint(1) not null default 0,
    current_step varchar(50) null,
    completed_steps text null,
    created_records text null,
    completed_at datetime null,
    created_at timestamp default current_timestamp,
    updated_at timestamp default current_timestamp on update current_timestamp
);

-- Additional tables can follow here

create table creditors (
    credid int auto_increment primary key,
    suppid int,
    creditdate date,
    age int,
    lastpaiddate date,
    balance decimal(18,2) default 0.00,
    d120 decimal(18,2) default 0.00,
    d30 decimal(18,2) default 0.00,
    d60 decimal(18,2) default 0.00,
    d90 decimal(18,2) default 0.00,
    lastpaid decimal(18,2) default 0.00,
    openingbalance decimal(18,2) default 0.00
);

create table customer_notes (
    noteid int auto_increment primary key,
    cid int,
    description varchar(254),
    note_date date,
    notetype varchar(20),
    status varchar(5)
);

create table customers (
    cid int auto_increment primary key,
    name varchar(30),
    surname varchar(50),
    address_1 varchar(100),
    address_2 varchar(100),
    address_3 varchar(100),
    address_4 varchar(50),
    address_code varchar(10),
    telnr varchar(20),
    tel_work varchar(50),
    mobile varchar(50),
    email varchar(100),
    status varchar(30),
    contact_person varchar(50),
    discount varchar(5),
    title varchar(5),
    jobs int,
    idnr varchar(15),
    customer_type varchar(10),
    contract_name varchar(100),
    cust_level char(20),
    taxid varchar(20),
    simplyaccount int,
    siid int,
    balance decimal(18,2) default 0.00,
    acc int,
    dbgid int,
    tel_fax varchar(50),
    mobile2 varchar(50),
    postad1 varchar(50),
    postad2 varchar(50),
    postad3 varchar(50),
    custsince date,
    accountstatus varchar(50),
    openingbalance decimal(18,2) default 0.00,
    salesrep int,
    chargerate decimal(18,2) default 0.00,
    department varchar(10),
    contact2 varchar(50),
    email2 varchar(100),
    merchantnr varchar(10),
    stocksales int,
    vendornr varchar(10),
    sageid int
);

create table debtor_groups (
    dbgid int auto_increment primary key,
    groupname varchar(50)
);

create table debtors (
    debtid int auto_increment primary key,
    cid int,
    debitdate date,
    age int,
    lastpaiddate date,
    balance decimal(18,2) default 0.00,
    d120 decimal(18,2) default 0.00,
    d30 decimal(18,2) default 0.00,
    d60 decimal(18,2) default 0.00,
    d90 decimal(18,2) default 0.00,
    lastpaid decimal(18,2) default 0.00
);

create table fin_cat (
    fcid int auto_increment primary key,
    accclass int,
    description varchar(50)
);

create table free_quotes (
    fqid int auto_increment primary key,
    cid int,
    quotenr int,
    quotedate date,
    quantity decimal(18,2) default 0.00,
    description varchar(250),
    status varchar(20),
    qtype varchar(20),
    lnr int,
    make varchar(50),
    model varchar(50),
    regnr varchar(10),
    amount decimal(18,2) default 0.00,
    milage int,
    policynr varchar(30),
    comments varchar(800),
    cost decimal(18,2) default 0.00,
    markup decimal(18,2),
    salesrep int,
    acceptstatus varchar(10),
    discount int,
    amounteach decimal(18,2) default 0.00,
    amountinc decimal(18,2) default 0.00,
    vat decimal(18,2) default 0.00
);

ALTER TABLE free_quotes AUTO_INCREMENT = 1000;

create table general_links (
    linkid int auto_increment primary key,
    description varchar(50),
    accnr int
);

create table user_groups (
    groupid int auto_increment primary key,
    user_groups varchar(30) not null
);

CREATE TABLE inspection (
    iid INT NOT NULL AUTO_INCREMENT,
    description VARCHAR(254),
    inr INT,
    section VARCHAR(100),
    summary VARCHAR(254),
    PRIMARY KEY (IID)
);

create table invoice_general (
    geninvid int auto_increment primary key,
    invoice_nr varchar(40),
    staff_id int,
    purchdate date,
    suppid int,
    payreff varchar(20),
    status varchar(20),
    amount decimal(18,2) default 0.00,
    amountexvat decimal(18,2) default 0.00,
    paid decimal(18,2) default 0.00,
    vat decimal(18,2) default 0.00,
    comments varchar(254),
    accnr int,
    supplier varchar(100),
    paymethod varchar(20),
    ptype varchar(20)
);

create table invoices (
    job_number int,
    cid int,
    invoice_date date,
    comments varchar(800),
    staff_id int not null,
    invoice_nr int auto_increment primary key,
    jobtype varchar(20),
    discount int,
    profit int,
    siid int,
    adjustments decimal(18,2) default 0.00,
    discountamount decimal(18,2) default 0.00,
    inv_totalexlvat decimal(18,2) default 0.00,
    inv_totalinclvat decimal(18,2) default 0.00,
    inv_totalvat decimal(18,2) default 0.00,
    paid decimal(18,2) default 0.00,
    regnr varchar(10),
    acc int,
    cost decimal(18,2) default 0.00,
    status varchar(10),
    roundingvalue decimal(18,2) default 0.00,
    paystatus varchar(10),
    splitnr int,
    quotenr int,
    recby int,
    gpamount decimal(18,2) default 0.00,
    transnr int,
    costtopartnr varchar(70),
    sageid int,
    posted_at datetime null default null,
    voided_at datetime null default null,
    void_reason varchar(255) null default null,
    credit_for_invoice_nr int null default null,
    replaces_invoice_nr int null default null
);

ALTER TABLE invoices AUTO_INCREMENT = 1000;

create table invoices_supplier (
    sinvid int auto_increment primary key,
    invoice_nr varchar(40),
    staff_id int,
    inv_date date,
    suppid int,
    payreff varchar(20),
    status varchar(20),
    siid int,
    amount decimal(18,2) default 0.00,
    amountexvat decimal(18,2) default 0.00,
    discount decimal(18,2) default 0.00,
    paid decimal(18,2) default 0.00,
    vat decimal(18,2) default 0.00,
    comments varchar(254),
    adjustment decimal(18,2) default 0.00,
    acc int,
    payable decimal(18,2) default 0.00,
    purchasetype varchar(20),
    rfcamount decimal(18,2) default 0.00,
    transnr int,
    grnnumber varchar(50),
    grncurrency varchar(10),
    ordernr varchar(50),
    posted_at datetime null default null,
    sageid int
);

create table invoice_items (
    invid int auto_increment primary key,
    invoice_nr varchar(40),
    staff_id int,
    inv_date date,
    stock_id int,
    suppid int,
    quantity decimal(18,2) default 0.00,
    payreff varchar(20),
    job_number int,
    status varchar(20),
    siid int,
    amount decimal(18,2) default 0.00,
    amountexvat decimal(18,2) default 0.00,
    discount decimal(18,2) default 0.00,
    paid decimal(18,2) default 0.00,
    vat decimal(18,2) default 0.00,
    comments varchar(254),
    adjustment decimal(18,2) default 0.00,
    acc int,
    description varchar(200),
    partnr varchar(70),
    grncurrency varchar(10),
    grnnumber int,
    accasset int,
    clearing decimal(18,2) default 0.00,
    exchangerate decimal(18,2) default 0.00,
    freight decimal(18,2) default 0.00,
    sellingprice decimal(18,2) default 0.00,
    costtopartnr varchar(70),
    sageid int
);

create table job_checklist (
    id int auto_increment primary key,
    enginetype varchar(10),
    towin varchar(5),
    running varchar(5),
    sparewheel varchar(5),
    jack varchar(5),
    mats varchar(5),
    money varchar(5),
    fuel varchar(10),
    toolkit varchar(5),
    oldparts varchar(5),
    body varchar(200),
    other varchar(200),
    job_number int,
    serviceadvisor varchar(100)
);

-- Vehicle check-in tables (see migrations/005_job_checkin.js)

create table equipment_checkin (
    id int auto_increment primary key,
    description varchar(100) not null,
    sort_order int not null default 0,
    is_active tinyint not null default 1
);

create table vehicle_checkin (
    id int auto_increment primary key,
    description varchar(100) not null,
    sort_order int not null default 0,
    is_active tinyint not null default 1
);

create table job_checkin (
    id int auto_increment primary key,
    job_number int not null,
    regnr varchar(20) not null,
    checked_equipment_json json not null,
    checked_vehicle_json json not null,
    notes text null,
    created_at timestamp default current_timestamp,
    created_by_staff_id int null,
    photos_json json null,
    index idx_job_checkin_job (job_number),
    index idx_job_checkin_regnr (regnr)
);

create table job_information (
    job_number int auto_increment primary key,
    cid int,
    status varchar(100) not null,
    date_received date,
    make varchar(50),
    model varchar(50),
    enginenr varchar(20),
    milage int,
    modelyear int,
    regnr varchar(10),
    chassis varchar(50),
    unitnr varchar(30),
    cont_job_number varchar(50),
    cont_auth varchar(50),
    cont_id int,
    comments varchar(800),
    staff_id int not null,
    date_finished date,
    status_date date,
    paystatus varchar(20),
    marketing varchar(20),
    recby int,
    salesrep int,
    vsid int,
    vinnr varchar(50),
    budget decimal(18,2) default 0.00,
    jobtype varchar(30),
    paymenttype varchar(15),
    invoice_nr int,
    invoice_total decimal(18,2) default 0.00,
    paid decimal(18,2) default 0.00,
    estfinish varchar(17),
    milageafter int,
    department varchar(100),
    location varchar(50),
    jnotes varchar(400),
    unittype varchar(20),
    splitnr int,
    wipstatus varchar(20),
    wipstaffname varchar(50),
    wipdt timestamp,
    staff_id2 int,
    staff_id3 int,
    grayimport varchar(5),
    temp_job_no varchar(50),
    inspectiondone varchar(5),
    syncto varchar(10),
    comeback varchar(5),
    approved varchar(10),
    fueltype varchar(30),
    licenseexpire date,
    alert_service_advisor varchar(10),
    checkin_id INT NULL DEFAULT NULL,
    index idx_job_information_checkin_id (checkin_id)
);

ALTER TABLE job_information AUTO_INCREMENT = 1000;

create table job_report (
    jrid int auto_increment primary key,
    job_number int,
    description varchar(4000),
    staff_id int
);

create table job_report_templates (
    jrepsid int auto_increment primary key,
    desciption varchar(20),
    repdetail varchar(4000)
);

create table journal (
    jourid int auto_increment primary key,
    jdate date,
    jtype int,
    module int,
    trxdate date,
    sourceid int,
    source varchar(40),
    debitamount decimal(18,2) default 0.00,
    description varchar(254),
    staff_id int,
    status varchar(30),
    accnr int,
    accclass int,
    ledgertype varchar(2),
    creditamount decimal(18,2) default 0.00,
    department int,
    company int,
    source2 varchar(40),
    cid int,
    vsid int,
    suppid int,
    ddate date,
    sourcename varchar(100),
    fperiod varchar(7),
    reconciled varchar(5),
    batch int,
    transnr int,
    hasvat varchar(5),
    serviceadvisor int,
    closed varchar(3),
    quantity decimal(9,2),
    stock_id int,
    bsid int,
    ledger_status varchar(20)
);

create table journal_entry (
    jourid int auto_increment primary key,
    jdate date,
    jtype int,
    module int,
    trxdate date,
    sourceid int,
    source varchar(40),
    debitamount decimal(18,2) default 0.00,
    description varchar(254),
    staff_id int,
    status varchar(30),
    accnr int,
    accclass int,
    ledgertype varchar(2),
    creditamount decimal(18,2) default 0.00,
    department int,
    source2 varchar(40),
    cid int,
    vsid int,
    suppid int
);

create table journal_temp (
    jourid int auto_increment primary key,
    jdate date,
    jtype int,
    module int,
    trxdate date,
    sourceid int,
    source varchar(40),
    debitamount decimal(18,2) default 0.00,
    description varchar(254),
    staff_id int,
    status varchar(30),
    accnr int,
    accclass int,
    ledgertype varchar(2),
    creditamount decimal(18,2) default 0.00,
    department int,
    company int,
    source2 varchar(40),
    cid int,
    vsid int,
    suppid int,
    ddate date,
    sourcename varchar(100),
    fperiod varchar(7),
    reconciled varchar(5),
    batch int,
    transnr int,
    hasvat varchar(5),
    serviceadvisor int,
    closed varchar(3),
    quantity decimal(9,2),
    stock_id int,
    bsid int
);

create table labour_links (
    linkid int auto_increment primary key,
    description varchar(50),
    accnr int
);

create table ledger (
    ledgerid int auto_increment primary key,
    trxdate date not null,
    accnr int not null,
    accclass int,
    debit decimal(18,2) default 0.00,
    credit decimal(18,2) default 0.00,
    description varchar(254),
    jounralid int,
    source varchar(40),
    company int not null,
    department int,
    period varchar(7),
    batch int,
    postedby int,
    postedon timestamp default current_timestamp,
    cid int,
    suppid int
);

create table license_disc (
    ldid int auto_increment primary key,
    persons varchar(50),
    control_number varchar(50),
    license_number varchar(50),
    vehicle_register_number varchar(50),
    vehicle_category varchar(100),
    make varchar(50),
    model varchar(50),
    colour varchar(50),
    vinnr varchar(50),
    engine_number varchar(50),
    date_of_expiry date
);

create table link_accounts (
    linkid int auto_increment primary key,
    invasset varchar(10),
    invrevenue varchar(10),
    invcogs varchar(10),
    invvariance varchar(10),
    servrevenue varchar(10),
    servexpense varchar(10),
    accountsreceiveable varchar(10),
    taxpayable varchar(10),
    accountspayable varchar(10),
    cashin varchar(10),
    cashout varchar(10),
    chequein varchar(10),
    chequeout varchar(10),
    ccardin varchar(10),
    ccardout varchar(10),
    taxpayablepurchases varchar(900),
    eftin varchar(10),
    sdiscounts varchar(10),
    srefunds varchar(10),
    sbaddebts varchar(10)
);

create table location (
    locid int auto_increment primary key,
    description varchar(50)
);

create table makes (
    make varchar(50),
    model varchar(50),
    mik int auto_increment primary key,
    bore decimal(18,2) default 0.00,
    capacity int,
    engtype varchar(15),
    vehiclecode varchar(10),
    yearfrom int,
    yearto int,
	labourrate decimal(18, 2) default 0.00
);

create table markup (
    markupid int auto_increment primary key,
    markup decimal(18,2) default 0.00,
    max_amount decimal(18,2) default 0.00,
    min_amount decimal(18,2) default 0.00
);

create table messages (
	id int auto_increment primary key,
    message_name varchar(100),
    message_body text
);

create table orders (
    oid int auto_increment primary key,
    orderdate date,
    description varchar(100),
    quantity decimal(9,2),
    supplier varchar(100),
    staff_id int,
    ordernr varchar(20),
    status varchar(15),
    stock_id int,
    partnr varchar(70),
    orderinvoice_nr varchar(30),
    job_number int,
    siid varchar(4),
    cost_price decimal(18,2) default 0.00,
    acc int,
    suppid int,
    eta date,
    comments varchar(300),
    onlinestatus varchar(50),
    suppidonline int,
    etatime time
);

create table payments (
    payid int auto_increment primary key,
    job_number int not null,
    staff_id int not null,
    paymethod varchar(100),
    paydate date not null,
    invoice_nr varchar(20),
    siid int,
    amount decimal(18,2) default 0.00,
    cashrendered decimal(18,2) default 0.00,
    changedue decimal(18,2) default 0.00,
    cid int,
    acc int,
    capturedate date,
    cnid int,
    vat decimal(18,2) default 0.00,
    transnr int,
    quotenr int,
    sageid int,
	notes varchar(500)
);

create table payments_suppliers (
    payid int auto_increment primary key,
    status varchar(30),
    staff_id int not null,
    paymethod varchar(100),
    chequenr varchar(20),
    paydate date not null,
    invoice_nr varchar(40),
    accnr int,
    vat decimal(18,2) default 0.00,
    amount decimal(18,2) default 0.00,
    discount decimal(18,2) default 0.00,
    suppid int,
    invid int,
    adjustment decimal(18,2) default 0.00,
    acc int,
    batchnr int,
    transnr int,
    sageid int,
	notes varchar(500)
);

create table phonebook (
    pbid int auto_increment primary key,
    telnr varchar(50),
    description varchar(100),
    address varchar(250),
    category varchar(30)
);

create table labour_pricing (
    wid int auto_increment primary key,
    description varchar(100),
    siid int,
    amount decimal(18,2) default 0.00,
    settype varchar(50),
    acc int,
    hoursworked decimal(18,2) default 0.00,
    partset varchar(5),
    sageid int
);

create table print_options (
    optionid int auto_increment primary key,
    reporttype varchar(50),
    reportheight varchar(50),
    reportwidth varchar(50),
    papername varchar(50),
    printername varchar(100),
    printpreview varchar(3),
    printdialouge varchar(3),
    copies int
);

create table purchases (
    purchase_id int auto_increment primary key,
    description varchar(150),
    quantity int,
    invoice_nr varchar(40),
    purchdate date,
    cost_price decimal(18,2) default 0.00,
    vat decimal(18,2) default 0.00,
    suppid int,
    accnr int,
    status varchar(20),
    suppidinv int,
    costtopartnr varchar(70)
);

create table remove_stock (
    rsid int auto_increment primary key,
    stock_id int not null,
    job_number int,
    invoice_nr varchar(50),
    description varchar(50),
    part_nr varchar(70),
    quantity int,
    rem_date date,
    staff_added int,
    staff_removed int,
    cost_price decimal(18,2) default 0.00,
    salesprice decimal(18,2) default 0.00
);

create table sales (
    sid int auto_increment primary key,
    description varchar(100),
    quantity int,
    sale_type varchar(50),
    staff_id int,
    sales_date date,
    status varchar(4),
    stock_id int,
    invoice_nr int,
    siid int,
    amount decimal(18,2) default 0.00,
    acc int,
    partnr varchar(70),
    amountexvat decimal(18,2) default 0.00
);

create table set_type (
    settypeid int auto_increment primary key,
    set_type varchar(20),
    cosacc int,
    revenueacc int
);

create table spares_used (
    spares_id int auto_increment primary key,
    job_number int,
    spare varchar(200),
    quantity decimal(9,2),
    stock_id int,
    date_used date,
    status varchar(15),
    jobtype varchar(20),
    partnr varchar(70),
    markup decimal(18,2) default 0.00,
    lnr int,
    stocktype varchar(15),
    staff_id int,
    siid int,
    cost_price decimal(18,2) default 0.00,
    sales_price decimal(18,2) default 0.00,
    vat decimal(18,2) default 0.00,
    settype varchar(50),
    acc int,
    outsidesupplier varchar(10),
    invoice_nr int,
    discountamount decimal(18,2) default 0.00,
    discountpercent decimal(18,2) default 0.00,
    dptmnt varchar(20),
    sales_priceincvat decimal(18,2) default 0.00,
    printoninvoice varchar(5),
    suppid int,
    quotenr int,
    partnrother varchar(50),
    accasset int,
    sageid int,
    wdid int
);

-- Staff table (uses AUTO_INCREMENT for primary key)
CREATE TABLE staff (
    staff_id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100),
    surname VARCHAR(100),
    idnr VARCHAR(13),
    staff_group VARCHAR(50),        
    status VARCHAR(30),
    address_1 VARCHAR(100),
    address_2 VARCHAR(100),
    address_3 VARCHAR(100),
    address_4 VARCHAR(50),
    address_code VARCHAR(10),
    telnr VARCHAR(100),
    mobile VARCHAR(100),
    rell VARCHAR(100),
    relltel VARCHAR(100),
    pinnr VARCHAR(50) NOT NULL,
    date_start DATE,
    leave_allowed INT,
    leave_left INT,
    absent INT,            
    candostock VARCHAR(5),
    candofinalise VARCHAR(5),
    canaddcreditor VARCHAR(5),
    candolabour VARCHAR(5),
    canaddebtor VARCHAR(5),
    candocreditnote VARCHAR(5),
    candorfc VARCHAR(5),
    canremovelabour VARCHAR(5),
    canremovestock VARCHAR(5),
    canaddpayments VARCHAR(5),
    canrelease VARCHAR(5),
    canreopenjobs VARCHAR(5),
    canorder VARCHAR(5),
    candoreports VARCHAR(5),
    canseereports VARCHAR(5),
    salary DECIMAL(18,2) DEFAULT 0.00,
    hourlyrate DECIMAL(18,2) DEFAULT 0.00,
    commpercent DECIMAL(18,2) DEFAULT 0.00,
    mibco DECIMAL(18,2) DEFAULT 0.00,
    other DECIMAL(18,2) DEFAULT 0.00,
    paye DECIMAL(18,2) DEFAULT 0.00,
    pfund DECIMAL(18,2) DEFAULT 0.00,
    sdl DECIMAL(18,2) DEFAULT 0.00,
    site DECIMAL(18,2) DEFAULT 0.00,
    uif DECIMAL(18,2) DEFAULT 0.00
);


create table staff_targets (
    tid int auto_increment primary key,
    staffnr int,
    ttype varchar(50),
    quantity decimal(18,2) default 0.00,
    accnr int
);

create table stock (
    stock_id int auto_increment primary key,
    description varchar(200),
    quantity decimal(9,2),
    markup decimal(18,2) default 0.00,
    invoice_nr varchar(20),
    partnr varchar(70),
    supplier varchar(100),
    requiredstock int,
    stocktype varchar(15),
    vat varchar(3),
    siid int,
    cost_price decimal(18,2) default 0.00,
    salesprice decimal(18,2) default 0.00,
    autoadd varchar(3),
    autoaddquantity decimal(9,2),
    settype varchar(50),
    binnr varchar(50),
    acc int,
    stocktake varchar(3),
    outsidesupplier varchar(10),
    partnrother varchar(50),
    addinfo varchar(200),
    status varchar(5),
    cost_price_exvat decimal(18,2) default 0.00,
    salespriceincvat decimal(18,2) default 0.00,
    recallstatus varchar(50),
    maincategory varchar(30),
    secondcategory varchar(30),
    thirdcategory varchar(30),
    fourthcategory varchar(30),
    selectitem varchar(5),
    salesprice2 decimal(18,2) default 0.00,
    salesprice3 decimal(18,2) default 0.00,
    ingoremarkup varchar(5),
    accasset int,
    onorderqty decimal(9,2),
    reorderlevel decimal(9,2),
    km int,
    sageid int,
	suppid int
);

create table stock_links (
    linkid int auto_increment primary key,
    description varchar(50),
    accnr int
);

create table stock_take (
    stocktakeid int auto_increment primary key,
    stock_id int,
    partnr varchar(70),
    description varchar(200),
    quantity decimal(9,2),
    stocktype varchar(15),
    cost_price decimal(18,2) default 0.00,
    newquantity decimal(18,2) default 0.00,
    takedate date,
    status varchar(20),
    diffquantity decimal(18,2) default 0.00,
    binnr varchar(50),
    costoverunder decimal(18,2) default 0.00
);

create table stock_takes (
    takeid int auto_increment primary key,
    stocktakeday varchar(15),
    lastcount int,
    set_type varchar(100),
    newcount int
);

create table suppliers (
    suppid  int auto_increment primary key,
    supplier varchar(100),
    contactperson varchar(100),
    telnr varchar(100),
    faxnr varchar(100),
    address_1 varchar(100),
    address_2 varchar(100),
    address_3 varchar(100),
    address_4 varchar(50),
    address_code varchar(10),
    alloweddiscount decimal(18,2) default 0.00,
    vatnr varchar(30),
    regnr varchar(20),
    email varchar(100),
    updtype varchar(50),
    simplyaccount int,
    siid int,
    balance decimal(18,2) default 0.00,
    exempt varchar(3),
    acc int,
    capricorn varchar(3),
    capricornnr varchar(20),
    internal varchar(3),
    sageid int
);

create table supplier_notes (
    noteid int auto_increment primary key,
    suppid int,
    description varchar(254),
    notedate date
);

create table temp_age (
    taid int auto_increment primary key,
    cid int,
    agedate date,
    outstanding decimal(18,2) default 0.00,
    sourcenr varchar(20),
    suppid int
);

create table vat_links (
    linkid int auto_increment primary key,
    description varchar(30),
    accnr int
);

create table wip_status (
    wipid int auto_increment primary key,
    description varchar(30),
    repgroup varchar(15),
    wipcolour varchar(30)
);

create table work_done (
    wdid int auto_increment primary key,
    job_number int,
    description varchar(200),
    jobtype varchar(20),
    siid int,
    workprice decimal(18,2) default 0.00,
    staff_id int,
    settype varchar(50),
    acc int,
    hoursworked decimal(18,2) default 0.00,
    invoice_nr int,
    workcost decimal(18,2) default 0.00,
    dptmnt varchar(20),
    actualworked decimal(18,2) default 0.00,
    workdate date,
    discountamount decimal(18,2) default 0.00,
    discountpercent decimal(18,2) default 0.00,
    quotenr int,
    workpriceincvat decimal(18,2) default 0.00,
    fwdid int,
    paid varchar(3),
    sageid int
);

create table work_timer (
    wtid int auto_increment primary key,
    staff_id int,
    job_number int,
    starttime time,
    endtime time,
    wdid int,
    status varchar(10),
    hoursworked decimal(18,2) default 0.00,
    hourspaused decimal(18,2) default 0.00,
    pauseend time,
    pausestart time,
    workdate date
);

create table work_todo (
    wtdid int auto_increment primary key,
    job_number int,
    description varchar(200),
    siid int,
    amount decimal(18,2) default 0.00,
    acc int
);

create table xero_settings (
    id int auto_increment primary key,
    company_id int not null,
    client_id varchar(100),
    client_secret varchar(100),
    redirect_uri varchar(200),
    access_token varchar(2000),
    refresh_token varchar(2000),
    token_expires timestamp,
    tenant_id varchar(100),
    created_at timestamp default current_timestamp,
    updated_at timestamp
);