'use strict';

const Document = require('./document');
const Query = require('./query');
const _ = require('lodash');
const bind = require('./utils').bind;
const composition = require('composition');
const debug = require('debug')('monogram:model:debug');
const defineMethod = require('./utils').defineMethod;
const inspect = require('util').inspect;
const mongodb = require('mongodb');

module.exports = ModelFactory;

function ModelFactory(db, options) {
  if (typeof options === 'string') {
    options = { collection: options };
  }

  var context = {
    db: db,
    options: options,
    collection: db.collection(options.collection),
    schema: options.schema
  };

  var model = function(doc, isNew) {
    Document(doc, arguments.length === 1 || !!isNew);

    var save = function*() {
      if (doc.$isNew()) {
        debug(`${db.databaseName}.${options.collection}: new doc ${inspect(doc)}`);

        const res = yield context.collection.update({ _id: doc._id }, doc,
          { upsert: true });

        if (!res.result.upserted || res.result.upserted.length !== 1) {
          throw new Error(`There is already a document with _id ${doc._id}`);
        }
        doc.$isNew(false);
      } else {
        const delta = clean(doc.$delta());
        if (!delta) {
          return;
        }
        debug(`${db.databaseName}.${options.collection}: updating doc with id ${doc._id}, delta: ${inspect(delta)}`);
        let res = yield context.collection.update({ _id: doc._id }, delta);
        if (res.result.nModified !== 1) {
          throw new Error('No documents with _id ' + doc._id + ' found');
        }
      }
    };

    defineMethod(doc, '$save', save);
    defineMethod(doc, '$model', function() {
      return model;
    });
    defineMethod(doc, '$schema', function() {
      return options.schema;
    });

    return doc;
  };

  context.model = model;
  context.Query = new Query(model, options.schema, context.collection);
  if (options.schema) {
    if (!options.schema._obj['_id']) {
      options.schema._obj['_id'] = { $type: mongodb.ObjectId };
    }

    options.schema.compile();
  }

  _.each(functions, function(fn, key) {
    model[key] = bind(fn, context);
  });
  return model;
}

var functions = {};

[
  'count', 'distinct', 'find', 'findOne', 'deleteOne', 'deleteMany',
  'replaceOne', 'updateOne', 'updateMany', 'findOneAndDelete',
  'findOneAndReplace', 'findOneAndUpdate'
].forEach(function(key) {
  functions[key] = function() {
    var q = new this.Query(this.model, this.collection);
    return q[key].apply(q, arguments);
  };
});

functions.insertMany = function(docs) {
  return _.map(docs, (v) => this.model(v, true).$save());
};

functions.insertOne = function(doc) {
  return this.model(doc, true).$save();
};

functions.db = function() {
  return this.db;
};

function clean(delta) {
  var clone = _.clone(delta);
  if (Object.keys(clone.$set).length === 0 &&
      Object.keys(clone.$unset).length === 0) {
    return;
  }
  if (Object.keys(clone.$set).length === 0) {
    delete clone.$set;
  }
  if (Object.keys(clone.$unset).length === 0) {
    delete clone.$unset;
  }
  return clone;
}
