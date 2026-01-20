/**
 * Central export for all migration models
 * Makes imports cleaner: const { Schema, Mapping, Plan } = require('./models');
 */

const Schema = require('./Schema');
const FieldMap = require('./FieldMap');
const Mapping = require('./Mapping');
const Plan = require('./Plan');
const Run = require('./Run');

module.exports = {
	Schema,
	FieldMap,
	Mapping,
	Plan,
	Run
};
