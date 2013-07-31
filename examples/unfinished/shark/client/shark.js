Items = new Meteor.Collection(null);
Items.insert({ text: 'Foo' });
Items.insert({ text: 'Bar' });
Items.insert({ text: 'Beef' });

Meteor.startup(function () {
  Meteor.setTimeout(function () {
    Items.insert({ text: 'Qux' });
    Items.remove({ text: 'Foo' });
    Items.update({ text: 'Bar' }, { text: 'Coke' });
  }, 1000);
});

UI.body.name = 'David';

UI.body.items = Items.find({}, { sort: { text: 1 }});

var removeNode = function (n) {
  n.parentNode.removeChild(n);
};

var insertNode = function (n, parent, next) {
  parent.insertBefore(n, next || null);
};

DomTemplate = function (start, end, subs) {
  this.start = start;
  this.end = end;
  this.subs = {};
  this.nextUid = 1;
  this.addSubs(subs);

  this.start.$ui = this;
};

_.extend(DomTemplate.prototype, {
  addSubs: function (newSubs) {
    var uid = this.nextUid;
    var subs = this.subs;
    _.each(newSubs, function (v) {
      subs[uid++] = v;
    });
    this.nextUid = uid;
  },
  parentNode: function () {
    return this.start.parentNode;
  },
  empty: function () {
    var parentNode = this.parentNode();
    if (! parentNode)
      return;

    var subs = this.subs;
    for (var k in subs) {
      var n = subs[k];
      if (n.parentNode === parentNode) {
        // sub is still there
        if (n.$ui && n.$ui.start === n)
          // sub-DomTemplate
          n.$ui.remove();
        else
          // sub-node or DomElement
          removeNode(n);
      }
    }
    this.subs = {};
  },
  remove: function () {
    this.empty();
    removeNode(this.start);
    removeNode(this.end);
  },
  prependDom: function (newNodes) {
    var parentNode = this.parentNode();
    if (! parentNode)
      return;
    var nextNode = this.start.nextSibling;

    for (var i = 0; i < newNodes.length; i++)
      insertNode(newNodes[i],
                 parentNode, nextNode);
  },
  appendDom: function (newNodes) {
    var parentNode = this.parentNode();
    if (! parentNode)
      return;
    var nextNode = this.end;

    for (var i = 0; i < newNodes.length; i++)
      insertNode(newNodes[i],
                 parentNode, nextNode);
  },
  moveBefore: function (nextNode) {
    var afterNode = this.end.nextSibling;
    var nodes = [];
    for (var n = this.start;
         n && n !== afterNode;
         n = n.nextSibling)
      nodes.push(n);

    var parentNode = this.parentNode();

    for (var i = 0; i < nodes.length; i++)
      insertNode(nodes[i], parentNode, nextNode);
  }
});

var newFragment = function (nodeArray) {
  // jQuery fragments are built specially in
  // IE<9 so that they can safely hold HTML5
  // elements.
  return $.buildFragment(nodeArray, document);
};

// A very basic operation like Underscore's `_.extend` that
// copies `src`'s own, enumerable properties onto `tgt` and
// returns `tgt`.
var _extend = function (tgt, src) {
  for (var k in src)
    if (src.hasOwnProperty(k))
      tgt[k] = src[k];
  return tgt;
};

var isArray = function (x) {
  return !!((typeof x.length === 'number') &&
            (x.sort || x.splice));
};

DomRange = function () {
  var start = document.createTextNode("");
  var end = document.createTextNode("");
  var fragment = newFragment([start, end]);

  this.start = start;
  start.$ui = this;
  this.end = end;

  this.children = {};
  this.nextChildId = 1;
};

_extend(DomRange.prototype, {
  parentNode: function () {
    return this.start.parentNode;
  },
  getNodes: function () {
    var afterNode = this.end.nextSibling;
    var nodes = [];
    for (var n = this.start;
         n && n !== afterNode;
         n = n.nextSibling)
      nodes.push(n);
    return nodes;
  },
  removeAll: function () {
    var parentNode = this.parentNode();
    if (! parentNode)
      return;

    var children = this.children;
    for (var k in children) {
      var rangeOrNode = children[k];
      if (rangeOrNode.parentNode === parentNode) {
        // node, still there
        removeNode(rangeOrNode);
      } else if (rangeOrNode.start &&
                 rangeOrNode.start.parentNode === parentNode) {
        // DomRange, still there
        rangeOrNode.remove();
      }
      delete children[k];
    }
  },
  getInsertionPoint: function (beforeId) {
    var children = this.children;
    var parentNode = this.parentNode();

    beforeId = '_' + beforeId;
    var nextNode;

    if (
      beforeId != null &&
        children.hasOwnProperty(beforeId) &&
        (nextNode = children[beforeId]) &&
        (nextNode.parentNode === parentNode ||
         (nextNode = nextNode.start) &&
         nextNode.parentNode === parentNode))
      return nextNode;

    return this.end;
  },
  add: function (id, rangeNodeOrContent, beforeId) {
    if (id && typeof id !== 'string') {
      beforeId = rangeNodeOrContent;
      rangeNodeOrContent = id;
      id = null;
    }

    if (isArray(rangeNodeOrContent)) {
      if (id != null)
        throw new Error("Can only add one node or one range if id is given");
      var content = rangeNodeOrContent;
      for (var i = 0; i < content.length; i++)
        this.add(content[i], beforeId);
      return;
    }

    var rangeOrNode = rangeNodeOrContent;
    if (id == null)
      id = this.nextChildId++;
    else
      id = '_' + id;

    var children = this.children;
    if (children.hasOwnProperty(id))
      throw new Error("Item already exists: " + id.slice(1));
    children[id] = rangeOrNode;

    var parentNode = this.parentNode();
    if (! parentNode)
      return;
    var nextNode = this.getInsertionPoint(beforeId);

    if (typeof rangeOrNode.getNodes === 'function') {
      // DomRange
      var nodes = rangeOrNode.getNodes();
      for (var i = 0; i < nodes.length; i++)
        insertNode(nodes[i], parentNode, nextNode);
    } else {
      // node
      insertNode(rangeOrNode, parentNode, nextNode);
    }
  },
  remove: function (id) {
    if (id == null) {
      // remove self
      this.removeAll();
      removeNode(this.start);
      removeNode(this.end);
      return;
    }

    id = '_' + id;
    var children = this.children;
    var rangeOrNode =
          (children.hasOwnProperty(id) &&
           children[id]);
    delete children[id];
    if (! rangeOrNode)
      return;

    var parentNode = this.parentNode();
    if (! parentNode)
      return;

    if (rangeOrNode.parentNode === parentNode) {
      // node
      removeNode(rangeOrNode);
    } else if (rangeOrNode.start &&
               rangeOrNode.start.parentNode === parentNode) {
      // DomRange
      rangeOrNode.remove();
    }
  },
  moveBefore: function (id, beforeId) {
    var nextNode = this.getInsertionPoint(beforeId);
    id = '_' + id;
    var children = this.children;
    var rangeOrNode =
          (children.hasOwnProperty(id) &&
           children[id]);
    if (! rangeOrNode)
      return;

    var parentNode = this.parentNode();
    if (! parentNode)
      return;


    if (rangeOrNode.parentNode === parentNode) {
      // node
      insertNode(rangeOrNode, parentNode, nextNode);
    } else if (rangeOrNode.start &&
               rangeOrNode.start.parentNode === parentNode) {
      // DomRange
      var nodes = rangeOrNode.getNodes();
      for (var i = 0; i < nodes.length; i++)
        insertNode(nodes[i], parentNode, nextNode);
    }
  }
});

Meteor.startup(function () {
  var R = window.R = new DomRange;
  $(document.body).append(R.getNodes());
  R.add('aaa', document.createTextNode('aaa'));
  R.add('bbb', document.createTextNode('bbb'));
  R.add('ccc', document.createTextNode('ccc'));
  R.add('zzz', document.createTextNode('zzz'),
        'bbb');
  R.remove('aaa');
  R.moveBefore('bbb', 'zzz');
  R.moveBefore('zzz', null);
  R.removeAll();
  R.add('aaa', document.createTextNode('aaa'));
});